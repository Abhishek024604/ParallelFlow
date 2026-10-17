import { SYSTEM_USER_ID, type Tx } from '@saras/db';
import { sql } from 'kysely';
import { addVersion, createArtifact } from '../artifacts/artifacts.js';
import {
  factsEntry,
  lastEntryAt,
  mergeLog,
  type ProgressEntry,
  type ProgressFacts,
} from './progress-log.js';

// Progress-log reads and writes. Every function takes the caller's transaction (the vote's verified
// tenant tx, or the progress job's system tx for the arena's own org) and filters by the project.
// Message text is never read here: only counts. The log itself is the arena's `progress` artifact.

/** Human messages since the last entry that make a new entry due. */
export const PROGRESS_MESSAGE_THRESHOLD = 20;
export const PROGRESS_FILE_NAME = 'progress.md';

export interface ProgressDoc {
  id: string;
  content: string;
}

/** The arena's progress log (latest version), or null before its first entry. */
export async function readProgressLog(tx: Tx, projectId: string): Promise<ProgressDoc | null> {
  const { rows } = await sql<{ id: string; content: Buffer | null }>`
    SELECT a.id, b.content
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.head_version_no
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.kind = 'progress'
     ORDER BY a.created_at
     LIMIT 1`.execute(tx);
  const row = rows[0];
  return row ? { id: row.id, content: row.content ? row.content.toString('utf8') : '' } : null;
}

/** The arena's AI (author of the log) and its session. */
export async function arenaAgent(
  tx: Tx,
  projectId: string,
): Promise<{ arenaId: string; agentId: string; agentSessionId: string } | null> {
  const row = await tx
    .selectFrom('arenas as ar')
    .innerJoin('agent_sessions as s', (j) =>
      j.onRef('s.arena_id', '=', 'ar.id').on('s.kind', '=', 'arena'),
    )
    .select(['ar.id as arenaId', 's.agent_id as agentId', 's.id as agentSessionId'])
    .where('ar.project_id', '=', projectId)
    .executeTakeFirst();
  return row ?? null;
}

/**
 * Whether enough people have talked since the last entry (checked after each arena message, in
 * the post's own transaction; stops counting at the threshold).
 */
export async function progressDue(tx: Tx, projectId: string, arenaId: string): Promise<boolean> {
  const { rows } = await sql<{ n: string }>`
    SELECT count(*) AS n FROM (
      SELECT 1 FROM messages m
       WHERE m.arena_id = ${arenaId} AND m.author_type = 'user' AND m.deleted_at IS NULL
         AND m.created_at > COALESCE(
               (SELECT max(a.updated_at) FROM artifacts a
                 WHERE a.project_id = ${projectId} AND a.kind = 'progress'),
               '-infinity'::timestamptz)
       LIMIT ${PROGRESS_MESSAGE_THRESHOLD}) recent`.execute(tx);
  return Number(rows[0]?.n ?? 0) >= PROGRESS_MESSAGE_THRESHOLD;
}

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

/** What changed since `since` (null: since the start): stage moves, gates, documents, counts. */
export async function progressFacts(
  tx: Tx,
  projectId: string,
  arenaId: string,
  since: string | null,
): Promise<ProgressFacts> {
  const from = since ?? '1970-01-01T00:00:00Z';
  const current = await tx
    .selectFrom('sdlc_cycles')
    .select(['number', 'stage'])
    .where('project_id', '=', projectId)
    .orderBy('number', 'desc')
    .executeTakeFirst();
  const { rows: moves } = await sql<{
    at: Date;
    cycle: number;
    from: string | null;
    to: string;
    kind: string;
    actor: string | null;
    reason: string | null;
  }>`
    SELECT t.created_at AS at, c.number AS cycle, t.from_stage::text AS "from",
           t.to_stage::text AS "to", t.kind, u.display_name AS actor, t.reason
      FROM stage_transitions t
      JOIN sdlc_cycles c ON c.id = t.cycle_id
      LEFT JOIN users u ON u.id = t.actor_id
     WHERE c.project_id = ${projectId} AND t.created_at > ${from}::timestamptz
     ORDER BY t.created_at
     LIMIT 50`.execute(tx);
  const { rows: approvals } = await sql<{
    at: Date;
    stage: string;
    status: string;
    summary: string | null;
    document: string | null;
  }>`
    SELECT ar.decided_at AS at, ar.stage::text AS stage, ar.status::text AS status,
           ar.detail ->> 'summary' AS summary,
           (SELECT a.name FROM artifacts a
             WHERE a.id::text = ar.detail ->> 'artifact_id' AND a.project_id = ${projectId}) AS document
      FROM approval_requests ar
     WHERE ar.project_id = ${projectId} AND ar.decided_at > ${from}::timestamptz
       AND ar.status IN ('approved', 'rejected')
     ORDER BY ar.decided_at
     LIMIT 20`.execute(tx);
  const { rows: documents } = await sql<{
    name: string;
    version: number;
    approved: boolean;
  }>`
    SELECT a.name, a.head_version_no AS version, a.approved_version_no IS NOT NULL AS approved
      FROM artifacts a
     WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.kind <> 'progress'
       AND a.updated_at > ${from}::timestamptz
     ORDER BY a.updated_at DESC
     LIMIT 20`.execute(tx);
  const { rows: counts } = await sql<{ people: string; ai: string }>`
    SELECT count(*) FILTER (WHERE m.author_type = 'user') AS people,
           count(*) FILTER (WHERE m.author_type = 'agent') AS ai
      FROM messages m
     WHERE m.arena_id = ${arenaId} AND m.deleted_at IS NULL
       AND m.created_at > ${from}::timestamptz`.execute(tx);
  return {
    since,
    cycle: current?.number ?? null,
    stage: current?.stage ?? null,
    moves: moves.map((m) => ({ ...m, at: iso(m.at) })),
    approvals: approvals.map((a) => ({ ...a, at: iso(a.at) })),
    documents,
    humanMessages: Number(counts[0]?.people ?? 0),
    aiMessages: Number(counts[0]?.ai ?? 0),
  };
}

/**
 * Adds (or replaces, same id) an entry: a new version of the arena's progress artifact, created on
 * the first entry. The AI is the author; source_ref marks the version as generated.
 */
export async function writeProgressEntry(
  tx: Tx,
  input: { orgId: string; projectId: string; agentId: string },
  entry: ProgressEntry,
): Promise<void> {
  const home = {
    kind: 'project' as const,
    userId: SYSTEM_USER_ID,
    orgId: input.orgId,
    projectId: input.projectId,
  };
  const author = { type: 'agent' as const, id: input.agentId };
  const source = { type: 'progress_log' as const, entry_id: entry.id, generated: entry.source };
  const doc = await readProgressLog(tx, input.projectId);
  const content = mergeLog(doc?.content, entry);
  if (doc) {
    if (doc.content === content) return;
    await addVersion(tx, home, doc.id, { content }, author, source);
  } else {
    await createArtifact(
      tx,
      home,
      { kind: 'progress', name: PROGRESS_FILE_NAME, content },
      author,
      source,
    );
  }
}

/**
 * The plain entry for an approved gate, written in the vote's own transaction so the gate's repo
 * commit already carries it. The AI's entry replaces it later (same id: `gate:<approval id>`).
 */
export async function recordGateProgress(
  tx: Tx,
  input: { orgId: string; projectId: string; approvalId: string; at: string },
): Promise<void> {
  const agent = await arenaAgent(tx, input.projectId);
  if (!agent) return;
  const id = gateEntryId(input.approvalId);
  const log = await readProgressLog(tx, input.projectId);
  const facts = await progressFacts(
    tx,
    input.projectId,
    agent.arenaId,
    lastEntryAt(log?.content, id),
  );
  await writeProgressEntry(
    tx,
    { orgId: input.orgId, projectId: input.projectId, agentId: agent.agentId },
    factsEntry({ id, at: input.at, trigger: 'gate' }, facts),
  );
}

export const gateEntryId = (approvalId: string): string => `gate:${approvalId}`;
