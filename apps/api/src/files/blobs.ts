import { createHash } from 'node:crypto';
import type { FileRef } from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { validationFailed } from '../pipeline/errors.js';

// File content (build step 6, ADR-034 / migration 0007). Phase A keeps the bytes in Postgres
// (`blobs.content`; SLICE_DEBT: S3, ADR-024). A blob belongs to an arena's org or, in Private, to
// one person (org_id NULL, owner_user_id). Content-addressed per owner: the same bytes are stored
// once and keep their first file name. Callers pass the matching transaction: the verified tenant of
// the arena, or the caller's user scope. RLS (tenant_isolation / private_space_blobs) backs that up.
// File content is never logged.

/** Whose blob: an arena's org (tenant tx) or a person's Private space (user-scope tx). */
export type BlobOwner = { org: string } | { user: string };

export interface StoredBlob {
  id: string;
  sha256: string;
  name: string | null;
  content_type: string;
  size_bytes: number;
}

export const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const ownerColumns = (owner: BlobOwner) =>
  'org' in owner
    ? { org_id: owner.org, owner_user_id: null }
    : { org_id: null, owner_user_id: owner.user };

function whereOwner(owner: BlobOwner) {
  return 'org' in owner
    ? sql`org_id = ${owner.org}`
    : sql`org_id IS NULL AND owner_user_id = ${owner.user}`;
}

/** Stores `bytes` (or finds the same bytes already stored for this owner). */
export async function putBlob(
  tx: Tx,
  owner: BlobOwner,
  input: { bytes: Uint8Array; contentType: string; name?: string },
): Promise<StoredBlob> {
  const sha = sha256Hex(input.bytes);
  const cols = ownerColumns(owner);
  const conflict = sql.raw('org' in owner ? 'blobs_org_sha256' : 'blobs_owner_sha256');
  await sql`
    INSERT INTO blobs (org_id, owner_user_id, sha256, size_bytes, content_type, content, name)
    VALUES (${cols.org_id}, ${cols.owner_user_id}, ${sha}, ${input.bytes.length}, ${input.contentType},
            ${Buffer.from(input.bytes)}, ${input.name ?? null})
    ON CONFLICT ON CONSTRAINT ${conflict} DO NOTHING`.execute(tx);
  const blob = await findBlobBySha(tx, owner, sha);
  if (!blob) throw new Error('Stored blob is not readable');
  return blob;
}

export async function findBlobBySha(
  tx: Tx,
  owner: BlobOwner,
  sha: string,
): Promise<StoredBlob | undefined> {
  const { rows } = await sql<StoredBlob & { size_bytes: string }>`
    SELECT id, sha256, name, content_type, size_bytes FROM blobs
     WHERE sha256 = ${sha} AND ${whereOwner(owner)}`.execute(tx);
  const row = rows[0];
  return row && { ...row, size_bytes: Number(row.size_bytes) };
}

/** A file's bytes and type by its public id, or undefined. */
export async function readFile(
  tx: Tx,
  owner: BlobOwner,
  fileId: string,
): Promise<(StoredBlob & { content: Buffer }) | undefined> {
  const { rows } = await sql<StoredBlob & { size_bytes: string; content: Buffer | null }>`
    SELECT id, sha256, name, content_type, size_bytes, content FROM blobs
     WHERE id = ${fileId} AND ${whereOwner(owner)}`.execute(tx);
  const row = rows[0];
  // s3_key-only blobs (none in Phase A) have no in-database content.
  if (!row?.content) return undefined;
  return { ...row, size_bytes: Number(row.size_bytes), content: row.content };
}

/** Text content of a blob by sha (artifact versions). */
export async function readText(tx: Tx, owner: BlobOwner, sha: string): Promise<string> {
  const { rows } = await sql<{ content: Buffer | null }>`
    SELECT content FROM blobs WHERE sha256 = ${sha} AND ${whereOwner(owner)}`.execute(tx);
  const content = rows[0]?.content;
  if (!content) throw new Error('Version content is missing');
  return content.toString('utf8');
}

export const fileRef = (blob: StoredBlob): FileRef => ({
  file_id: blob.id,
  name: blob.name ?? 'file',
  mime_type: blob.content_type,
  size_bytes: blob.size_bytes,
});

/** Message attachments: every id must be a file of this owner. Order kept, duplicates dropped. */
export async function resolveAttachments(
  tx: Tx,
  owner: BlobOwner,
  ids: readonly string[] | undefined,
): Promise<FileRef[]> {
  const unique = [...new Set(ids ?? [])];
  if (unique.length === 0) return [];
  const { rows } = await sql<StoredBlob & { size_bytes: string }>`
    SELECT id, sha256, name, content_type, size_bytes FROM blobs
     WHERE id = ANY(${unique}::uuid[]) AND ${whereOwner(owner)}`.execute(tx);
  const byId = new Map(rows.map((r) => [r.id, { ...r, size_bytes: Number(r.size_bytes) }]));
  const missing = unique.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw validationFailed(
      [{ field: 'attachments', message: 'Upload the file here first' }],
      'One of the files was not uploaded here.',
    );
  }
  return unique.flatMap((id) => {
    const blob = byId.get(id);
    return blob ? [fileRef(blob)] : [];
  });
}
