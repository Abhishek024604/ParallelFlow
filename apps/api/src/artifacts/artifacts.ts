import type {
  Artifact,
  ArtifactKind,
  ArtifactVersion,
  CreateArtifact,
  NewVersion,
} from '@saras/contracts';
import { hasUnsafeNameChars, uuidv7 } from '@saras/contracts';
import type { Tx } from '@saras/db';
import { type RawBuilder, sql } from 'kysely';
import { type BlobOwner, putBlob, readText } from '../files/blobs.js';
import { hasCapability } from '../arenas/messages.js';
import { ApiError, notFound } from '../pipeline/errors.js';

// Text artifacts and their versions (build step 6; openapi_v2.yaml Artifacts tag). Two homes:
//   private  – yours only, no org (ADR-034, migration 0007); the pipeline's user-scope tx
//   project  – an arena's, in its org; the verified tenant tx of @ProjectScoped routes
// Every query also filters by its home, on top of RLS. Versions are immutable; a new version bumps
// `head_version_no` under a row lock. Content is never logged.

export const ARTIFACT_EDIT = 'artifact.edit';

export type ArtifactHome =
  | { kind: 'private'; userId: string }
  | { kind: 'project'; userId: string; orgId: string; projectId: string };

export interface Author {
  type: 'user' | 'agent';
  id: string;
}

/** Where a version came from (artifact_versions.source_ref). */
export type VersionSource =
  | { type: 'private_session'; id: string | null }
  | { type: 'arena_turn'; id: string }
  | { type: 'private_turn'; id: string }
  | {
      type: 'push';
      artifact_id: string;
      version_no: number;
      private_session_id: string | null;
    }
  | { type: 'upload'; id: null };

export const blobOwnerOf = (home: ArtifactHome): BlobOwner =>
  home.kind === 'private' ? { user: home.userId } : { org: home.orgId };

function inHome(home: ArtifactHome): RawBuilder<unknown> {
  return home.kind === 'private'
    ? sql`a.org_id IS NULL AND a.scope = 'private' AND a.owner_user_id = ${home.userId}`
    : sql`a.scope = 'project' AND a.project_id = ${home.projectId} AND a.org_id = ${home.orgId}`;
}

/** The blob row of a version, whichever owner it has. */
const VERSION_BLOB = sql`(b.sha256 = v.blob_sha256 AND (
    (v.org_id IS NOT NULL AND b.org_id = v.org_id)
    OR (v.org_id IS NULL AND b.org_id IS NULL AND b.owner_user_id = v.blob_owner_user_id)))`;

interface ArtifactRow {
  id: string;
  lineage_id: string;
  scope: 'private' | 'project';
  kind: ArtifactKind;
  name: string;
  project_id: string | null;
  private_session_id: string | null;
  head_version_no: number;
  approved_version_no: number | null;
  size_bytes: string | null;
  created_at: Date;
  updated_at: Date;
}

const toArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  lineage_id: row.lineage_id,
  scope: row.scope,
  kind: row.kind,
  name: row.name,
  project_id: row.project_id,
  private_session_id: row.private_session_id,
  head_version_no: row.head_version_no,
  approved_version_no: row.approved_version_no,
  size_bytes: Number(row.size_bytes ?? 0),
  created_at: new Date(row.created_at).toISOString(),
  updated_at: new Date(row.updated_at).toISOString(),
});

async function selectArtifacts(
  tx: Tx,
  home: ArtifactHome,
  where: RawBuilder<unknown>,
  limit = 200,
): Promise<Artifact[]> {
  const { rows } = await sql<ArtifactRow>`
    SELECT a.id, a.lineage_id, a.scope, a.kind, a.name, a.project_id, a.private_session_id,
           a.head_version_no, a.approved_version_no, a.created_at, a.updated_at,
           (SELECT b.size_bytes FROM artifact_versions v JOIN blobs b ON ${VERSION_BLOB}
             WHERE v.artifact_id = a.id AND v.version_no = a.head_version_no) AS size_bytes
      FROM artifacts a
     WHERE ${inHome(home)} ${where}
     ORDER BY a.updated_at DESC, a.id DESC
     LIMIT ${limit}`.execute(tx);
  return rows.map(toArtifact);
}

/** GET /artifacts (private) or /projects/{id}/artifacts: most recently updated first. */
export function listArtifacts(
  tx: Tx,
  home: ArtifactHome,
  filter: { privateSessionId?: string } = {},
): Promise<Artifact[]> {
  return selectArtifacts(
    tx,
    home,
    filter.privateSessionId ? sql`AND a.private_session_id = ${filter.privateSessionId}` : sql``,
  );
}

/** One artifact in this home, or 404. */
export async function getArtifact(tx: Tx, home: ArtifactHome, id: string): Promise<Artifact> {
  const [artifact] = await selectArtifacts(tx, home, sql`AND a.id = ${id}`, 1);
  if (!artifact) throw notFound();
  return artifact;
}

interface VersionRow {
  version_no: number;
  status: ArtifactVersion['status'];
  blob_sha256: string;
  size_bytes: string;
  change_note: string | null;
  created_by_type: 'user' | 'agent' | 'service';
  created_by: string;
  display_name: string | null;
  approved_by: string | null;
  source_ref: { type?: unknown } | null;
  created_at: Date;
}

const toVersion = (row: VersionRow): ArtifactVersion => ({
  version_no: row.version_no,
  status: row.status,
  blob_sha256: row.blob_sha256,
  size_bytes: Number(row.size_bytes),
  change_note: row.change_note,
  created_by: {
    type: row.created_by_type,
    id: row.created_by,
    display_name: row.created_by_type === 'user' ? (row.display_name ?? 'Former teammate') : 'AI',
  },
  approved_by: row.approved_by,
  source:
    row.source_ref && typeof row.source_ref.type === 'string'
      ? { type: row.source_ref.type }
      : null,
  created_at: new Date(row.created_at).toISOString(),
});

async function selectVersions(
  tx: Tx,
  artifactId: string,
  where: RawBuilder<unknown>,
): Promise<ArtifactVersion[]> {
  const { rows } = await sql<VersionRow>`
    SELECT v.version_no, v.status, v.blob_sha256, b.size_bytes, v.change_note, v.created_by_type,
           v.created_by, u.display_name, v.approved_by, v.source_ref, v.created_at
      FROM artifact_versions v
      JOIN blobs b ON ${VERSION_BLOB}
      LEFT JOIN users u ON v.created_by_type = 'user' AND u.id = v.created_by
     WHERE v.artifact_id = ${artifactId} ${where}
     ORDER BY v.version_no DESC`.execute(tx);
  return rows.map(toVersion);
}

/** GET …/artifacts/{id}/versions: newest first. */
export async function listVersions(
  tx: Tx,
  home: ArtifactHome,
  id: string,
): Promise<ArtifactVersion[]> {
  await getArtifact(tx, home, id);
  return selectVersions(tx, id, sql``);
}

/** One version and its text, or 404. */
export async function versionContent(
  tx: Tx,
  home: ArtifactHome,
  id: string,
  versionNo: number,
): Promise<{ artifact: Artifact; version: ArtifactVersion; text: string }> {
  const artifact = await getArtifact(tx, home, id);
  const [version] = await selectVersions(tx, id, sql`AND v.version_no = ${versionNo}`);
  if (!version) throw notFound();
  const text = await readText(tx, blobOwnerOf(home), version.blob_sha256);
  return { artifact, version, text };
}

/** Arena writes need artifact.edit (doc 03); a clear 403 before RLS. */
export async function requireEdit(tx: Tx, home: ArtifactHome): Promise<void> {
  if (home.kind !== 'project') return;
  if (!(await hasCapability(tx, home.projectId, home.userId, ARTIFACT_EDIT))) {
    throw new ApiError(403, 'FORBIDDEN', {
      detail: 'You can read files in this arena but not change them.',
      requiredPermission: `cap ${ARTIFACT_EDIT}`,
    });
  }
}

async function insertVersion(
  tx: Tx,
  home: ArtifactHome,
  input: {
    artifactId: string;
    versionNo: number;
    content: string;
    changeNote: string | null;
    author: Author;
    source: VersionSource;
  },
): Promise<string> {
  const blob = await putBlob(tx, blobOwnerOf(home), {
    bytes: new TextEncoder().encode(input.content),
    contentType: 'text/markdown',
  });
  const id = uuidv7();
  await tx
    .insertInto('artifact_versions')
    .values({
      id,
      org_id: home.kind === 'project' ? home.orgId : null,
      artifact_id: input.artifactId,
      version_no: input.versionNo,
      blob_sha256: blob.sha256,
      blob_owner_user_id: home.kind === 'private' ? home.userId : null,
      status: 'draft',
      change_note: input.changeNote,
      source_ref: JSON.stringify(input.source),
      created_by_type: input.author.type,
      created_by: input.author.id,
    })
    .execute();
  return id;
}

/** POST /artifacts or /projects/{id}/artifacts: the artifact and its version 1 (a draft). */
export async function createArtifact(
  tx: Tx,
  home: ArtifactHome,
  input: Pick<CreateArtifact, 'kind' | 'name' | 'content'> & {
    privateSessionId?: string | null;
    lineageId?: string;
    changeNote?: string | null;
  },
  author: Author,
  source: VersionSource,
): Promise<{ artifact: Artifact; versionId: string }> {
  const id = uuidv7();
  await tx
    .insertInto('artifacts')
    .values({
      id,
      org_id: home.kind === 'project' ? home.orgId : null,
      lineage_id: input.lineageId ?? uuidv7(),
      scope: home.kind,
      kind: input.kind,
      name: input.name,
      owner_user_id: home.kind === 'private' ? home.userId : null,
      private_session_id: home.kind === 'private' ? (input.privateSessionId ?? null) : null,
      project_id: home.kind === 'project' ? home.projectId : null,
      head_version_no: 1,
      created_by_type: author.type,
      created_by: author.id,
    })
    .execute();
  const versionId = await insertVersion(tx, home, {
    artifactId: id,
    versionNo: 1,
    content: input.content,
    changeNote: input.changeNote ?? null,
    author,
    source,
  });
  return { artifact: await getArtifact(tx, home, id), versionId };
}

/** POST …/artifacts/{id}/versions: the next version number, under a row lock. */
export async function addVersion(
  tx: Tx,
  home: ArtifactHome,
  id: string,
  input: NewVersion,
  author: Author,
  source: VersionSource,
): Promise<{ version: ArtifactVersion; versionId: string }> {
  const { rows } = await sql<{ head_version_no: number }>`
    UPDATE artifacts a SET head_version_no = a.head_version_no + 1, updated_at = now(),
                           version = a.version + 1
     WHERE a.id = ${id} AND ${inHome(home)}
     RETURNING a.head_version_no`.execute(tx);
  const head = rows[0]?.head_version_no;
  if (!head) throw notFound();
  const versionId = await insertVersion(tx, home, {
    artifactId: id,
    versionNo: head,
    content: input.content,
    changeNote: input.change_note ?? null,
    author,
    source,
  });
  const [version] = await selectVersions(tx, id, sql`AND v.version_no = ${head}`);
  if (!version) throw new Error('New version is not readable');
  return { version, versionId };
}

/** What the runtime's artifact.proposed may store (RIC ArtifactProposed, validated here). */
export interface DraftProposal {
  name: string;
  kind: string;
  content: string;
}

const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

/**
 * artifact.proposed from an AI turn: a draft, never approved. The same name in the same home (and
 * for Private, the same chat) gets a new version; otherwise a new artifact. Invalid proposals
 * (empty or oversize content, bad name) are dropped. Returns the artifact id and its new version, or
 * null.
 */
export async function saveDraft(
  tx: Tx,
  home: ArtifactHome,
  proposal: DraftProposal,
  input: { agentId: string; privateSessionId: string | null; source: VersionSource },
): Promise<{ id: string; versionNo: number } | null> {
  const name = proposal.name.trim().slice(0, 120);
  if (!name || hasUnsafeNameChars(name)) return null;
  if (!proposal.content || new TextEncoder().encode(proposal.content).length > MAX_DRAFT_BYTES) {
    return null;
  }
  const kinds: readonly string[] = [
    'goal',
    'spec',
    'plan',
    'test_report',
    'release_notes',
    'document',
    'diagram',
    'other',
  ];
  const kind = (kinds.includes(proposal.kind) ? proposal.kind : 'document') as ArtifactKind;
  const author: Author = { type: 'agent', id: input.agentId };
  const chat =
    home.kind === 'private'
      ? input.privateSessionId
        ? sql`AND a.private_session_id = ${input.privateSessionId}`
        : sql`AND a.private_session_id IS NULL`
      : sql``;
  const { rows } = await sql<{ id: string }>`
    SELECT a.id FROM artifacts a WHERE ${inHome(home)} AND a.name = ${name} ${chat}
     ORDER BY a.updated_at DESC LIMIT 1`.execute(tx);
  const existing = rows[0]?.id;
  if (existing) {
    const { version } = await addVersion(
      tx,
      home,
      existing,
      { content: proposal.content },
      author,
      input.source,
    );
    return { id: existing, versionNo: version.version_no };
  }
  const { artifact } = await createArtifact(
    tx,
    home,
    { kind, name, content: proposal.content, privateSessionId: input.privateSessionId },
    author,
    input.source,
  );
  return { id: artifact.id, versionNo: 1 };
}
