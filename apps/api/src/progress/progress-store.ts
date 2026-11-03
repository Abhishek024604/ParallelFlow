import { authorLabel } from '@parallelflow/contracts';
import { SYSTEM_USER_ID, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { addVersion, createArtifact, type VersionSource } from '../artifacts/artifacts.js';
import {
  type ActivityEvent,
  type ActivityFiles,
  type ActivityInput,
  isActivityLog,
  renderActivity,
} from './activity-log.js';
import {
  type GateDecision,
  isLegacyLog,
  type ProgressContext,
  type ProgressFacts,
  type StageMove,
} from './progress-log.js';
import { legacyStateDays, renderState, STATE_FILE_NAME } from './state-log.js';

// Reads and writes of the arena's two log files. Every function takes the caller's transaction (the
// vote's verified tenant tx, or a system job's tx for the arena's own org) and filters by the
// project. Message text is never read here: only counts.
//   PROGRESS.md  the `progress` artifact: the activity log, rendered from the arena's events
//                (activity-log.ts, ADR-044)
//   STATE.md     the `stage_summary` artifact: the arena's story, told each night from its memory
//                graph (memory/, ADR-045); its older date-wise format is state-log.ts.
//                `stage_summary` rather than `document`: it is a generated summary, not a teammate's
//                document, so it is found by kind (never by name), is never offered for approval and
//                stays out of the "documents changed" facts.

export const PROGRESS_FILE_NAME = 'PROGRESS.md';

type LogKind = 'progress' | 'stage_summary';

export interface LogDoc {
  id: string;
  content: string;
  /** The head version and its source_ref (the activity log keeps its legacy version there). */
  versionNo: number;
  source: Record<string, unknown> | null;
}

async function readLogDoc(tx: Tx, projectId: string, kind: LogKind): Promise<LogDoc | null> {
  const { rows } = await sql<{
    id: string;
    content: Buffer | null;
    version_no: number;
    source_ref: Record<string, unknown> | null;
  }>`
    SELECT a.id, b.content, v.version_no, v.source_ref
      FROM artifacts a
      JOIN artifact_versions v ON v.artifact_id = a.id AND v.version_no = a.head_version_no
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.kind = ${kind}
     ORDER BY a.created_at
     LIMIT 1`.execute(tx);
  const row = rows[0];
  return row
    ? {
        id: row.id,
        content: row.content ? row.content.toString('utf8') : '',
        versionNo: row.version_no,
        source: row.source_ref,
      }
    : null;
}

/** The arena's PROGRESS.md (latest version), or null before its first entry. */
export const readProgressLog = (tx: Tx, projectId: string) => readLogDoc(tx, projectId, 'progress');

/** The arena's STATE.md (latest version), or null before its first update. */
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

export interface Writer {
  orgId: string;
  projectId: string;
  agentId: string;
}

/** STATE.md as a whole (the nightly memory story, ADR-045): a new version only when it changed. */
export async function writeStateContent(
  tx: Tx,
  input: Writer,
  content: string,
  source: VersionSource,
): Promise<void> {
  const doc = await readStateLog(tx, input.projectId);
  await saveLog(tx, input, 'stage_summary', doc, content, source);
}

/** One version of STATE.md (the legacy one, published once as docs/state/legacy.md). */
export async function stateVersion(
  tx: Tx,
  artifactId: string,
  versionNo: number,
): Promise<string | null> {
  const { rows } = await sql<{ content: Buffer | null }>`
    SELECT b.content FROM artifact_versions v
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE v.artifact_id = ${artifactId} AND v.version_no = ${versionNo}`.execute(tx);
  return rows[0]?.content ? rows[0].content.toString('utf8') : null;
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
  const name = kind === 'progress' ? PROGRESS_FILE_NAME : STATE_FILE_NAME;
  if (doc) {
    // Logs created before 24 Oct are named progress.md / state.md: they take the uppercase name.
    await tx
      .updateTable('artifacts')
      .set({ name })
      .where('id', '=', doc.id)
      .where('name', '!=', name)
      .execute();
    if (doc.content !== content) await addVersion(tx, home, doc.id, { content }, author, source);
    return;
  }
  await createArtifact(tx, home, { kind, name, content }, author, source);
}

// ---------------------------------------------------------------- PROGRESS.md: the activity log

interface EventRow {
  id: string;
  occurred_at: Date;
  action: string;
  actor_type: 'user' | 'agent' | 'service';
  actor_name: string | null;
  actor_roles: string[] | null;
  target_name: string | null;
  metadata: Record<string, unknown> | null;
}

/** Events read per render: far more than an arena makes; the oldest beyond it are left out. */
export const ACTIVITY_EVENT_LIMIT = 20_000;

/**
 * The arena's events, newest first; with `range` ([from, until), ISO instants) only those in it
 * (the nightly memory reads one day). Names and roles are today's (a renamed teammate shows their
 * new name everywhere).
 */
export async function readArenaEvents(
  tx: Tx,
  projectId: string,
  range?: { from: string; until: string },
  limit = ACTIVITY_EVENT_LIMIT,
): Promise<ActivityEvent[]> {
  const within = range
    ? sql`AND e.occurred_at >= ${range.from}::timestamptz AND e.occurred_at < ${range.until}::timestamptz`
    : sql``;
  const { rows } = await sql<EventRow>`
    SELECT e.id::text AS id, e.occurred_at, e.action, e.actor_type::text AS actor_type,
           u.display_name AS actor_name,
           CASE WHEN e.actor_type = 'user' THEN ARRAY(
             SELECT r.name FROM project_member_roles pmr JOIN project_roles r ON r.id = pmr.role_id
              WHERE pmr.project_id = e.project_id AND pmr.user_id = e.actor_id
              ORDER BY (r.system_kind = 'owner') DESC NULLS LAST, r.name) END AS actor_roles,
           tu.display_name AS target_name, e.metadata
      FROM audit_events e
      LEFT JOIN users u ON e.actor_type = 'user' AND u.id = e.actor_id
      LEFT JOIN users tu ON e.target_type = 'user'
                        AND tu.id = CASE WHEN e.target_id ~ '^[0-9a-fA-F-]{36}$'
                                         THEN e.target_id::uuid END
     WHERE e.project_id = ${projectId} ${within}
     ORDER BY e.id DESC
     LIMIT ${limit}`.execute(tx);
  return rows.map((e) => ({
    id: e.id,
    at: iso(e.occurred_at),
    action: e.action,
    actorType: e.actor_type,
    actorName: e.actor_name,
    actorRoles: e.actor_roles ?? [],
    targetName: e.target_name,
    metadata: e.metadata ?? {},
  }));
}

/** Everything the activity log shows, read in the caller's transaction (system job or member). */
export async function activityInput(tx: Tx, projectId: string): Promise<ActivityInput> {
  const project = await tx
    .selectFrom('projects')
    .select('name')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  const events = await readArenaEvents(tx, projectId);
  const { rows: now } = await sql<{
    cycle: number | null;
    stage: string | null;
    gate_stage: string | null;
    gate_to: string | null;
    gate_approvals: number | null;
    gate_required: number | null;
    members: number;
    open_pulls: number;
    today: string;
  }>`
    SELECT c.number AS cycle, c.stage::text AS stage,
           g.stage::text AS gate_stage, g.detail ->> 'to' AS gate_to,
           (SELECT count(*)::int FROM approval_votes v
             WHERE v.approval_id = g.id AND v.decision = 'approve') AS gate_approvals,
           g.min_approvals AS gate_required,
           (SELECT count(*)::int FROM project_members pm WHERE pm.project_id = ${projectId}) AS members,
           (SELECT count(*)::int FROM pull_requests pr
             WHERE pr.project_id = ${projectId}
               AND pr.status IN ('open', 'approved', 'changes_requested')) AS open_pulls,
           to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today
      FROM (SELECT 1) one
      LEFT JOIN LATERAL (
        SELECT number, stage FROM sdlc_cycles WHERE project_id = ${projectId}
         ORDER BY (status = 'active') DESC, number DESC LIMIT 1) c ON true
      LEFT JOIN LATERAL (
        SELECT ar.id, ar.stage, ar.detail, ar.min_approvals FROM approval_requests ar
         WHERE ar.project_id = ${projectId} AND ar.status = 'pending' AND ar.expires_at > now()
         ORDER BY ar.created_at DESC LIMIT 1) g ON true`.execute(tx);
  const n = now[0];
  return {
    arenaName: project.name,
    today: n?.today ?? new Date().toISOString().slice(0, 10),
    now: {
      cycle: n?.cycle ?? null,
      stage: n?.stage ?? null,
      gate: n?.gate_stage
        ? {
            stage: n.gate_stage,
            to: n.gate_to,
            approvals: n.gate_approvals ?? 0,
            required: n.gate_required ?? 1,
          }
        : null,
      members: n?.members ?? 0,
      openPulls: n?.open_pulls ?? 0,
    },
    events,
  };
}

/**
 * The version of PROGRESS.md last written in an older format (published once as
 * docs/progress/legacy.md), or null. Found from the head version: the first activity-log write
 * names it in its source_ref, and every later write carries it on.
 */
function legacyVersionOf(doc: LogDoc | null): number | null {
  if (!doc) return null;
  if (!isActivityLog(doc.content)) return doc.versionNo;
  const v = doc.source?.legacy_version;
  return typeof v === 'number' ? v : null;
}

/** The old-format PROGRESS.md content, or null when there was none. */
export async function legacyProgress(tx: Tx, projectId: string): Promise<string | null> {
  const doc = await readProgressLog(tx, projectId);
  const legacy = legacyVersionOf(doc);
  if (!doc || legacy === null) return null;
  if (legacy === doc.versionNo) return doc.content;
  const { rows } = await sql<{ content: Buffer | null }>`
    SELECT b.content FROM artifact_versions v
      JOIN blobs b ON b.org_id = v.org_id AND b.sha256 = v.blob_sha256
     WHERE v.artifact_id = ${doc.id} AND v.version_no = ${legacy}`.execute(tx);
  return rows[0]?.content ? rows[0].content.toString('utf8') : null;
}

/** PROGRESS.md and its archives, rendered from the events (the repo snapshot). */
export async function renderActivityFiles(tx: Tx, projectId: string): Promise<ActivityFiles> {
  const input = await activityInput(tx, projectId);
  const hasLegacy = legacyVersionOf(await readProgressLog(tx, projectId)) !== null;
  return renderActivity({ ...input, hasLegacy });
}

/**
 * Rewrites the app's PROGRESS.md from the events: a new version only when the text changed.
 * Returns whether it changed. The first write over an older log keeps that log as its legacy
 * version (and, for the oldest AI-written format, moves its discussions into STATE.md as before).
 */
export async function writeActivityLog(tx: Tx, input: Writer): Promise<boolean> {
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
  const legacy = legacyVersionOf(doc);
  const files = renderActivity({
    ...(await activityInput(tx, input.projectId)),
    hasLegacy: legacy !== null,
  });
  if (doc?.content === files.progress) return false;
  const source = {
    type: 'activity_log' as const,
    legacy_version: legacy,
    generated: 'auto' as const,
  };
  await saveLog(tx, input, 'progress', doc, files.progress, source);
  return true;
}

/**
 * A passed gate, in the vote's own transaction so the gate's repo commit already carries it:
 * PROGRESS.md re-rendered from the events (the vote, the decision and the move are among them).
 * STATE.md is no longer written here: it is the nightly story of the arena's memory (ADR-045).
 */
export async function recordGateProgress(
  tx: Tx,
  input: { orgId: string; projectId: string; approvalId: string },
): Promise<void> {
  const agent = await arenaAgent(tx, input.projectId);
  if (!agent) return;
  await writeActivityLog(tx, {
    orgId: input.orgId,
    projectId: input.projectId,
    agentId: agent.agentId,
  });
}

export const gateEntryId = (approvalId: string): string => `gate:${approvalId}`;
