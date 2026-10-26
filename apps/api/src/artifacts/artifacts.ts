import type {
  Artifact,
  ArtifactKind,
  ArtifactVersion,
  ArtifactVersionSource,
  AuthorFacts,
  CreateArtifact,
  NewVersion,
  PushedTo,
  SdlcStage,
} from '@parallelflow/contracts';
import {
  authorLabel,
  FILE_NAME_RULE,
  hasUnsafeNameChars,
  isStandardFileName,
  sourceLabel,
  uuidv7,
} from '@parallelflow/contracts';
import { readInEachMemberProject, softDelete, sqlLiteral, type Tx } from '@parallelflow/db';
import { type RawBuilder, sql } from 'kysely';
import { type BlobOwner, putBlob, readText } from '../files/blobs.js';
import { hasCapability } from '../arenas/messages.js';
import { requireActiveArena, requireArenaOwner } from '../arenas/arena-admin.js';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';

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
  | { type: 'upload'; id: null }
  /** A PROGRESS.md entry (progress/): built by the app from the recorded facts. */
  | { type: 'progress_log'; entry_id: string; generated: 'ai' | 'auto' }
  /** A STATE.md day (progress/): written by the arena's AI, or from the recorded decisions. */
  | { type: 'state_log'; day: string; generated: 'ai' | 'auto' };

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

/**
 * The person whose message started the AI turn that wrote version `v` (arena turns only):
 * joins `<t>` (runtime_turns) and `<ru>` (users). Same tenant as the version; RLS unchanged.
 */
const turnRequester = (v: string, t: string, ru: string) =>
  sql.raw(`LEFT JOIN runtime_turns ${t}
         ON ${v}.created_by_type = 'agent' AND ${v}.source_ref->>'type' = 'arena_turn'
        AND ${t}.id = CASE WHEN ${v}.source_ref->>'id' ~ '^[0-9a-fA-F-]{36}$'
                           THEN (${v}.source_ref->>'id')::uuid END
       LEFT JOIN users ${ru} ON ${ru}.id = ${t}.requested_by`);

interface ArtifactRow {
  id: string;
  lineage_id: string;
  scope: 'private' | 'project';
  kind: ArtifactKind;
  name: string;
  stage: SdlcStage | null;
  project_id: string | null;
  private_session_id: string | null;
  head_version_no: number;
  approved_version_no: number | null;
  size_bytes: string | null;
  created_at: Date;
  updated_at: Date;
  head_by_type: 'user' | 'agent' | 'service' | null;
  head_by_name: string | null;
  head_on_behalf_name: string | null;
}

const toArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  lineage_id: row.lineage_id,
  scope: row.scope,
  kind: row.kind,
  name: row.name,
  stage: row.stage,
  project_id: row.project_id,
  private_session_id: row.private_session_id,
  head_version_no: row.head_version_no,
  approved_version_no: row.approved_version_no,
  size_bytes: Number(row.size_bytes ?? 0),
  created_at: new Date(row.created_at).toISOString(),
  updated_at: new Date(row.updated_at).toISOString(),
  last_author: row.head_by_type
    ? authorLabel({
        sourceType: null,
        authorType: row.head_by_type,
        authorName: row.head_by_name,
        onBehalfOfName: row.head_on_behalf_name,
        versionNo: row.head_version_no,
      })
    : null,
});

async function selectArtifacts(
  tx: Tx,
  home: ArtifactHome,
  where: RawBuilder<unknown>,
  limit = 200,
): Promise<Artifact[]> {
  const { rows } = await sql<ArtifactRow>`
    SELECT a.id, a.lineage_id, a.scope, a.kind, a.name, a.stage, a.project_id, a.private_session_id,
           a.head_version_no, a.approved_version_no, a.created_at, a.updated_at,
           hb.size_bytes, hb.head_by_type, hb.head_by_name, hb.head_on_behalf_name
      FROM artifacts a
      LEFT JOIN LATERAL (
        SELECT b.size_bytes, v.created_by_type AS head_by_type, u.display_name AS head_by_name,
               ru.display_name AS head_on_behalf_name
          FROM artifact_versions v
          JOIN blobs b ON ${VERSION_BLOB}
          LEFT JOIN users u ON v.created_by_type = 'user' AND u.id = v.created_by
          ${turnRequester('v', 't', 'ru')}
         WHERE v.artifact_id = a.id AND v.version_no = a.head_version_no
         LIMIT 1) hb ON true
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
  approved_by_name: string | null;
  approved_at: Date | null;
  on_behalf_name: string | null;
  source_ref: { type?: unknown; version_no?: unknown } | null;
  created_at: Date;
}

type SourceRow = Pick<
  VersionRow,
  'source_ref' | 'created_by_type' | 'created_by' | 'display_name' | 'version_no'
> & { on_behalf_name?: string | null };

const factsOf = (row: SourceRow): AuthorFacts => {
  const ref = row.source_ref;
  return {
    sourceType: ref && typeof ref.type === 'string' ? ref.type : null,
    authorType: row.created_by_type,
    authorName: row.display_name,
    onBehalfOfName: row.on_behalf_name ?? null,
    versionNo: row.version_no,
    privateVersionNo: typeof ref?.version_no === 'number' ? ref.version_no : null,
  };
};

/** source_ref for display: type and a plain label; for a push its Private version and pusher. */
export function versionSource(row: SourceRow): ArtifactVersionSource | null {
  const ref = row.source_ref;
  if (!ref || typeof ref.type !== 'string') return null;
  const label = sourceLabel(factsOf(row));
  if (ref.type !== 'push') return { type: ref.type, label };
  return {
    type: 'push',
    label,
    from: 'private',
    ...(typeof ref.version_no === 'number' && { private_version_no: ref.version_no }),
    ...(row.created_by_type === 'user' && {
      pushed_by: { id: row.created_by, display_name: row.display_name ?? 'Former teammate' },
    }),
  };
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
    display_name: authorLabel(factsOf(row)),
  },
  approved_by: row.approved_by,
  approved_by_name: row.approved_by ? (row.approved_by_name ?? 'Former teammate') : null,
  approved_at: row.approved_at ? new Date(row.approved_at).toISOString() : null,
  source: versionSource(row),
  created_at: new Date(row.created_at).toISOString(),
});

async function selectVersions(
  tx: Tx,
  artifactId: string,
  where: RawBuilder<unknown>,
): Promise<ArtifactVersion[]> {
  const { rows } = await sql<VersionRow>`
    SELECT v.version_no, v.status, v.blob_sha256, b.size_bytes, v.change_note, v.created_by_type,
           v.created_by, u.display_name, v.approved_by, ua.display_name AS approved_by_name,
           v.approved_at, ru.display_name AS on_behalf_name, v.source_ref, v.created_at
      FROM artifact_versions v
      JOIN blobs b ON ${VERSION_BLOB}
      LEFT JOIN users u ON v.created_by_type = 'user' AND u.id = v.created_by
      LEFT JOIN users ua ON ua.id = v.approved_by
      ${turnRequester('v', 't', 'ru')}
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
  const versions = await selectVersions(tx, id, sql``);
  if (home.kind !== 'private') return versions;
  const pushes = await pushesOf(tx, home.userId, id);
  return versions.map((v) => ({
    ...v,
    pushed_to: pushes
      .filter((p) => p.private_version_no === v.version_no)
      .map(({ project_id, arena_name, arena_version_no, pushed_at }) => ({
        project_id,
        arena_name,
        arena_version_no,
        pushed_at,
      })),
  }));
}

/**
 * Where your private artifact's versions were pushed: the arena versions whose source_ref names it,
 * read in each arena you are still a member of (its verified tenant; RLS unchanged). Newest first.
 */
async function pushesOf(
  tx: Tx,
  userId: string,
  artifactId: string,
): Promise<(PushedTo & { private_version_no: number })[]> {
  const rows = await readInEachMemberProject<{
    project_id: string;
    arena_name: string;
    arena_version_no: number;
    private_version_no: number;
    pushed_at: Date | string;
  }>(
    tx,
    userId,
    (ids) => `
      SELECT p.id AS project_id, p.name AS arena_name, v.version_no AS arena_version_no,
             (v.source_ref->>'version_no')::int AS private_version_no, v.created_at AS pushed_at
        FROM artifact_versions v
        JOIN artifacts a ON a.id = v.artifact_id
        JOIN projects p ON p.id = a.project_id
       WHERE a.project_id IN ${ids} AND a.scope = 'project'
         AND v.source_ref->>'type' = 'push'
         AND v.source_ref->>'artifact_id' = ${sqlLiteral(artifactId)}
         AND v.created_by_type = 'user' AND v.created_by = ${sqlLiteral(userId)}`,
  );
  return rows
    .map((r) => ({
      project_id: r.project_id,
      arena_name: r.arena_name,
      arena_version_no: Number(r.arena_version_no),
      private_version_no: Number(r.private_version_no),
      pushed_at: new Date(r.pushed_at).toISOString(),
    }))
    .sort((x, y) => y.pushed_at.localeCompare(x.pushed_at));
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

/**
 * POST /projects/{id}/artifacts/{id}/approve: the arena owner approves the latest version (Phase A:
 * the owner approves, rule 5); POST /artifacts/{id}/approve: you approve your own private file.
 * Humans close the loop: no agent and no tool can reach this. The version must still be the
 * latest, so nobody approves a version they have not seen.
 */
export async function approveVersion(
  tx: Tx,
  home: ArtifactHome,
  id: string,
  versionNo: number,
): Promise<Artifact> {
  // A private file is approved by its owner (getArtifact finds only your own); an arena document by
  // the arena's owner.
  if (home.kind === 'project') {
    const { rows: owner } = await sql<{ ok: boolean }>`
      SELECT EXISTS (SELECT 1 FROM project_member_roles pmr
                       JOIN project_roles r ON r.id = pmr.role_id AND r.system_kind = 'owner'
                      WHERE pmr.project_id = ${home.projectId} AND pmr.user_id = ${home.userId}) AS ok`.execute(
      tx,
    );
    if (!owner[0]?.ok) {
      throw new ApiError(403, 'FORBIDDEN', {
        detail: 'Only the arena owner approves documents.',
        requiredPermission: 'arena owner',
      });
    }
  }
  const artifact = await getArtifact(tx, home, id);
  if (artifact.head_version_no !== versionNo) {
    throw new ApiError(409, 'CONFLICT', {
      detail: `Version ${versionNo} is no longer the latest (v${artifact.head_version_no}): open the latest and approve that.`,
    });
  }
  if (artifact.approved_version_no === versionNo) return artifact;
  await sql`
    WITH a AS (
      UPDATE artifacts a SET approved_version_no = ${versionNo}, updated_at = now()
       WHERE a.id = ${id} AND ${inHome(home)}
      RETURNING a.id
    )
    UPDATE artifact_versions v
       SET status = 'approved', approved_by = ${home.userId}, approved_at = now()
      FROM a WHERE v.artifact_id = a.id AND v.version_no = ${versionNo}`.execute(tx);
  return getArtifact(tx, home, id);
}

/** Arena writes need artifact.edit (doc 03); a clear 403 before RLS. */
export async function requireEdit(tx: Tx, home: ArtifactHome): Promise<void> {
  if (home.kind !== 'project') return;
  await requireActiveArena(tx, home.projectId);
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

/** 400 unless `name` is a standard arena file name (ADR-038). Private names are free-form. */
export function requireArenaFileName(name: string, field = 'name'): void {
  if (!isStandardFileName(name))
    throw validationFailed([{ field, message: FILE_NAME_RULE }], FILE_NAME_RULE);
}

/**
 * DELETE /artifacts/{id} (your own private file) or /projects/{id}/artifacts/{id} (arena owner only,
 * ADR-038). Soft: the file and its versions stay for audit and RLS hides them from then on.
 */
export async function deleteArtifact(tx: Tx, home: ArtifactHome, id: string): Promise<void> {
  const artifact = await getArtifact(tx, home, id);
  if (home.kind === 'project') {
    await requireArenaOwner(tx, home.projectId, home.userId, 'delete arena files');
    await requireActiveArena(tx, home.projectId);
    if (artifact.kind === 'progress' || artifact.kind === 'stage_summary') {
      throw new ApiError(409, 'CONFLICT', {
        detail: 'PROGRESS.md and STATE.md are kept by the arena and cannot be deleted.',
      });
    }
  }
  await softDelete(tx, 'artifacts', artifact.id, home.userId);
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
  if (home.kind === 'project') requireArenaFileName(input.name);
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
      // An arena file is filed under the stage the arena's loop is in when it is created.
      stage:
        home.kind === 'project'
          ? sql<SdlcStage>`(SELECT stage FROM sdlc_cycles WHERE project_id = ${home.projectId}
                             ORDER BY (status = 'active') DESC, number DESC LIMIT 1)`
          : null,
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
  // App Tools refuses non-standard arena names first, so the AI can retry; this is the backstop.
  if (home.kind === 'project' && !isStandardFileName(name)) return null;
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
