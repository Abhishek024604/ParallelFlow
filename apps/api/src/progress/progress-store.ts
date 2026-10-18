import { authorLabel } from '@saras/contracts';
import { SYSTEM_USER_ID, type Tx } from '@saras/db';
import { sql } from 'kysely';
import { addVersion, createArtifact, type VersionSource } from '../artifacts/artifacts.js';
import {
  type CommitFact,
  commitsForEntry,
  dayOf,
  type GateDecision,
  isLegacyLog,
  lastEntryAt,
  mergeLog,
  type ProgressContext,
  type ProgressEntry,
  type ProgressFacts,
  type StageMove,
} from './progress-log.js';
import {
  factsDay,
  legacyStateDays,
  mergeState,
  renderState,
  STATE_FILE_NAME,
  type StateDay,
} from './state-log.js';

// Reads and writes of the arena's two log files. Every function takes the caller's transaction (the
// vote's verified tenant tx, or the progress job's system tx for the arena's own org) and filters by
// the project. Message text is never read here: only counts.
//   progress.md  the `progress` artifact: the factual project log (progress-log.ts)
//   state.md     the `stage_summary` artifact: the AI's date-wise discussion summary (state-log.ts).
//                `stage_summary` rather than `document`: it is a generated summary, not a teammate's
//                document, so it is found by kind (never by name), is never offered for approval and
//                stays out of the "documents changed" facts.

/** Human messages since the last entry that make a new entry due. */
export const PROGRESS_MESSAGE_THRESHOLD = 20;
export const PROGRESS_FILE_NAME = 'progress.md';

type LogKind = 'progress' | 'stage_summary';

export interface LogDoc {
  id: string;
  content: string;
}

async function readLogDoc(tx: Tx, projectId: string, kind: LogKind): Promise<LogDoc | null> {
  const { rows } = await sql<{ id: string; content: Buffer | null }>`
    SELECT a.id, b.content
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.head_version_no
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.kind = ${kind}
     ORDER BY a.created_at
     LIMIT 1`.execute(tx);
  const row = rows[0];
  return row ? { id: row.id, content: row.content ? row.content.toString('utf8') : '' } : null;
}

/** The arena's progress.md (latest version), or null before its first entry. */
export const readProgressLog = (tx: Tx, projectId: string) => readLogDoc(tx, projectId, 'progress');

/** The arena's state.md (latest version), or null before its first update. */
export const readStateLog = (tx: Tx, projectId: string) =>
  readLogDoc(tx, projectId, 'stage_summary');

/** The arena's AI (author of the logs) and its session. */
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

/** The database clock, so entry times compare with the rows' own times. */
export async function dbNow(tx: Tx): Promise<string> {
  const { rows } = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
  return iso(rows[0]?.now ?? new Date());
}

const FOREVER = '9999-12-31T00:00:00Z';
const START = '1970-01-01T00:00:00Z';

async function movesBetween(
  tx: Tx,
  projectId: string,
  from: string,
  until: string,
  limit: number,
): Promise<StageMove[]> {
  const { rows } = await sql<Omit<StageMove, 'at'> & { at: Date }>`
    SELECT t.created_at AS at, c.number AS cycle, t.from_stage::text AS "from",
           t.to_stage::text AS "to", t.kind, u.display_name AS actor, t.reason
      FROM stage_transitions t
      JOIN sdlc_cycles c ON c.id = t.cycle_id
      LEFT JOIN users u ON u.id = t.actor_id
     WHERE c.project_id = ${projectId}
       AND t.created_at > ${from}::timestamptz AND t.created_at <= ${until}::timestamptz
     ORDER BY t.created_at
     LIMIT ${limit}`.execute(tx);
  return rows.map((m) => ({ ...m, at: iso(m.at) }));
}

async function decisionsBetween(
  tx: Tx,
  projectId: string,
  from: string,
  until: string,
  limit: number,
): Promise<GateDecision[]> {
  // The deciders are the votes for the outcome (approve for an approval, reject for a rejection).
  const { rows } = await sql<Omit<GateDecision, 'at'> & { at: Date }>`
    SELECT ar.decided_at AS at, ar.stage::text AS stage, ar.status::text AS status,
           ar.detail ->> 'summary' AS summary,
           (SELECT a.name FROM artifacts a
             WHERE a.id::text = ar.detail ->> 'artifact_id' AND a.project_id = ${projectId}) AS document,
           COALESCE(ARRAY(
             SELECT COALESCE(u.display_name, 'A former teammate')
               FROM approval_votes v LEFT JOIN users u ON u.id = v.user_id
              WHERE v.approval_id = ar.id
                AND v.decision = CASE WHEN ar.status = 'approved' THEN 'approve' ELSE 'reject' END
              ORDER BY v.created_at), '{}') AS deciders,
           COALESCE(ARRAY(
             SELECT v.reason FROM approval_votes v
              WHERE v.approval_id = ar.id AND v.reason IS NOT NULL AND v.reason <> ''
                AND v.decision = CASE WHEN ar.status = 'approved' THEN 'approve' ELSE 'reject' END
              ORDER BY v.created_at), '{}') AS reasons
      FROM approval_requests ar
     WHERE ar.project_id = ${projectId} AND ar.status IN ('approved', 'rejected')
       AND ar.decided_at > ${from}::timestamptz AND ar.decided_at <= ${until}::timestamptz
     ORDER BY ar.decided_at
     LIMIT ${limit}`.execute(tx);
  return rows.map((a) => ({ ...a, at: iso(a.at) }));
}

/** What the record shows in (since, until]: moves, gates, versions, pushes, approvals, counts. */
export async function progressFacts(
  tx: Tx,
  projectId: string,
  arenaId: string,
  since: string | null,
  until: string,
): Promise<ProgressFacts> {
  const from = since ?? START;
  const current = await tx
    .selectFrom('sdlc_cycles')
    .select(['number', 'stage'])
    .where('project_id', '=', projectId)
    .orderBy('number', 'desc')
    .executeTakeFirst();
  const moves = await movesBetween(tx, projectId, from, until, 50);
  const approvals = await decisionsBetween(tx, projectId, from, until, 20);
  // New versions of the arena's documents (not the two logs), with who wrote or pushed them.
  const { rows: versions } = await sql<{
    at: Date;
    name: string;
    version: number;
    by_type: 'user' | 'agent' | 'service';
    by_name: string | null;
    for_name: string | null;
    source: string | null;
    private_version: string | null;
  }>`
    SELECT v.created_at AS at, a.name, v.version_no AS version, v.created_by_type::text AS by_type,
           u.display_name AS by_name, ru.display_name AS for_name,
           v.source_ref ->> 'type' AS source, v.source_ref ->> 'version_no' AS private_version
      FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id
      LEFT JOIN users u ON v.created_by_type = 'user' AND u.id = v.created_by
      LEFT JOIN runtime_turns t
             ON v.created_by_type = 'agent' AND v.source_ref ->> 'type' = 'arena_turn'
            AND t.id = CASE WHEN v.source_ref ->> 'id' ~ '^[0-9a-fA-F-]{36}$'
                            THEN (v.source_ref ->> 'id')::uuid END
      LEFT JOIN users ru ON ru.id = t.requested_by
     WHERE a.project_id = ${projectId} AND a.scope = 'project'
       AND a.kind NOT IN ('progress', 'stage_summary')
       AND v.created_at > ${from}::timestamptz AND v.created_at <= ${until}::timestamptz
     ORDER BY v.created_at
     LIMIT 40`.execute(tx);
  const { rows: approvedVersions } = await sql<{
    at: Date;
    name: string;
    version: number;
    by: string | null;
  }>`
    SELECT v.approved_at AS at, a.name, v.version_no AS version, u.display_name AS by
      FROM artifact_versions v
      JOIN artifacts a ON a.id = v.artifact_id
      LEFT JOIN users u ON u.id = v.approved_by
     WHERE a.project_id = ${projectId} AND a.scope = 'project'
       AND v.approved_at > ${from}::timestamptz AND v.approved_at <= ${until}::timestamptz
     ORDER BY v.approved_at
     LIMIT 20`.execute(tx);
  const { rows: counts } = await sql<{ people: string; ai: string }>`
    SELECT count(*) FILTER (WHERE m.author_type = 'user') AS people,
           count(*) FILTER (WHERE m.author_type = 'agent') AS ai
      FROM messages m
     WHERE m.arena_id = ${arenaId} AND m.deleted_at IS NULL
       AND m.created_at > ${from}::timestamptz AND m.created_at <= ${until}::timestamptz`.execute(
    tx,
  );
  return {
    since,
    until,
    cycle: current?.number ?? null,
    stage: current?.stage ?? null,
    moves,
    approvals,
    versions: versions.map((v) => ({
      at: iso(v.at),
      name: v.name,
      version: v.version,
      author: authorLabel({
        sourceType: v.source,
        authorType: v.by_type,
        authorName: v.by_name,
        onBehalfOfName: v.for_name,
        versionNo: v.version,
      }),
      pushedFrom: v.source === 'push' ? Number(v.private_version ?? 0) || 0 : null,
    })),
    approvedVersions: approvedVersions.map((v) => ({ ...v, at: iso(v.at) })),
    humanMessages: Number(counts[0]?.people ?? 0),
    aiMessages: Number(counts[0]?.ai ?? 0),
  };
}

/** Where the cycle is now, and every stage move and gate decision so far (the Timeline). */
export async function progressContext(tx: Tx, projectId: string): Promise<ProgressContext> {
  const current = await tx
    .selectFrom('sdlc_cycles')
    .select(['number', 'stage', 'status'])
    .where('project_id', '=', projectId)
    .orderBy('number', 'desc')
    .executeTakeFirst();
  return {
    current: current ?? null,
    moves: await movesBetween(tx, projectId, START, FOREVER, 500),
    decisions: await decisionsBetween(tx, projectId, START, FOREVER, 200),
  };
}

interface Writer {
  orgId: string;
  projectId: string;
  agentId: string;
}

/** A new version of one of the logs (created on its first write); no version when unchanged. */
async function saveLog(
  tx: Tx,
  input: Writer,
  kind: LogKind,
  doc: LogDoc | null,
  content: string,
  source: VersionSource,
): Promise<void> {
  const home = {
    kind: 'project' as const,
    userId: SYSTEM_USER_ID,
    orgId: input.orgId,
    projectId: input.projectId,
  };
  const author = { type: 'agent' as const, id: input.agentId };
  if (doc) {
    if (doc.content !== content) await addVersion(tx, home, doc.id, { content }, author, source);
    return;
  }
  const name = kind === 'progress' ? PROGRESS_FILE_NAME : STATE_FILE_NAME;
  await createArtifact(tx, home, { kind, name, content }, author, source);
}

/** Merges a day's update into state.md. */
export async function writeStateDay(tx: Tx, input: Writer, day: StateDay): Promise<void> {
  const doc = await readStateLog(tx, input.projectId);
  const source = { type: 'state_log' as const, day: day.date, generated: day.source };
  await saveLog(tx, input, 'stage_summary', doc, mergeState(doc?.content, day), source);
}

/**
 * Adds (or replaces, same id) an entry of progress.md, re-rendering its Timeline. The first write
 * over the old AI-written log moves that log's discussion content into state.md.
 */
export async function writeProgressEntry(
  tx: Tx,
  input: Writer,
  entry: Omit<ProgressEntry, 'commits'>,
  repoCommits: readonly CommitFact[],
): Promise<void> {
  const doc = await readProgressLog(tx, input.projectId);
  if (doc && isLegacyLog(doc.content) && !(await readStateLog(tx, input.projectId))) {
    const days = legacyStateDays(doc.content);
    if (days.length) {
      await saveLog(tx, input, 'stage_summary', null, renderState(days), {
        type: 'state_log',
        day: days[0]?.date ?? '',
        generated: 'ai',
      });
    }
  }
  const commits = commitsForEntry(doc?.content, entry.id, repoCommits);
  const content = mergeLog(doc?.content, await progressContext(tx, input.projectId), {
    ...entry,
    commits,
  });
  const source = { type: 'progress_log' as const, entry_id: entry.id, generated: 'auto' as const };
  await saveLog(tx, input, 'progress', doc, content, source);
}

/**
 * The factual entry and the recorded decisions for an approved gate, written in the vote's own
 * transaction so the gate's repo commit already carries both files. The progress job then adds the
 * gate's commit to the entry (same id: `gate:<approval id>`) and the AI's summary to state.md.
 */
export async function recordGateProgress(
  tx: Tx,
  input: { orgId: string; projectId: string; approvalId: string },
): Promise<void> {
  const agent = await arenaAgent(tx, input.projectId);
  if (!agent) return;
  const id = gateEntryId(input.approvalId);
  const at = await dbNow(tx);
  const log = await readProgressLog(tx, input.projectId);
  const facts = await progressFacts(
    tx,
    input.projectId,
    agent.arenaId,
    lastEntryAt(log?.content, id),
    at,
  );
  const writer = { orgId: input.orgId, projectId: input.projectId, agentId: agent.agentId };
  await writeProgressEntry(tx, writer, { id, at, trigger: 'gate', facts }, []);
  await writeStateDay(tx, writer, factsDay(dayOf(at), facts));
}

export const gateEntryId = (approvalId: string): string => `gate:${approvalId}`;
