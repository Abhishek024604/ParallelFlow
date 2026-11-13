import type { Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { listProjectMembers } from '../arenas/messages.js';
import { dayBounds, loadDays, loadEdges, loadNodes } from './memory-store.js';
import type {
  CycleFact,
  FileFact,
  PlaybookFacts,
  PlaybookInput,
  RecentMessage,
} from './playbook.js';
import { SINCE_MESSAGES } from './playbook.js';

// The playbook's data (STATE.md, ADR-045): the database facts at render time and the memory graph.
// Every query runs in the caller's transaction for this one arena and filters by its project: the
// nightly job's system transaction, or a member's verified tenant context (withProjectMember, the
// bridge and gate commits), where RLS shows that arena's rows only. Message text is read only to
// hand it to the arena's own AI or to a linked chat of one of its members; it is never logged.

interface CycleRow {
  number: number;
  title: string;
  stage: string;
  status: string;
  created_day: string;
  transitions: { from: string | null; to: string; kind: string; day: string }[];
  approvals: {
    stage: string;
    day: string | null;
    approvers: (string | null)[];
    artifact_id: string | null;
  }[];
}

interface FileRow {
  n: number;
  id: string;
  name: string;
  stage: string | null;
  head_version_no: number;
  approved_version_no: number | null;
  updated_day: string;
  authors: string[];
}

/**
 * `card`: only what the card needs (no files, no edges); the arena @AI reads it on every turn.
 */
export async function loadPlaybook(
  tx: Tx,
  projectId: string,
  part: 'full' | 'card' = 'full',
): Promise<PlaybookInput & { timezone: string }> {
  const { rows: projects } = await sql<{
    name: string;
    description: string | null;
    timezone: string;
    created_day: string;
  }>`
    SELECT name, description, timezone,
           to_char(created_at AT TIME ZONE timezone, 'YYYY-MM-DD') AS created_day
      FROM projects WHERE id = ${projectId}`.execute(tx);
  const project = projects[0];
  if (!project) throw new Error('no project');
  const tz = project.timezone;

  const { rows: cycles } = await sql<CycleRow>`
    SELECT c.number, c.title, c.stage::text AS stage, c.status::text AS status,
           to_char(c.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS created_day,
           COALESCE((SELECT json_agg(json_build_object(
                        'from', st.from_stage, 'to', st.to_stage, 'kind', st.kind,
                        'day', to_char(st.created_at AT TIME ZONE ${tz}, 'YYYY-MM-DD'))
                      ORDER BY st.created_at)
                       FROM stage_transitions st WHERE st.cycle_id = c.id), '[]'::json) AS transitions,
           COALESCE((SELECT json_agg(json_build_object(
                        'stage', ar.stage,
                        'day', to_char(ar.decided_at AT TIME ZONE ${tz}, 'YYYY-MM-DD'),
                        'artifact_id', ar.detail ->> 'artifact_id',
                        'approvers', COALESCE((SELECT json_agg(u.display_name ORDER BY v.created_at)
                                                 FROM approval_votes v
                                                 LEFT JOIN users u ON u.id = v.user_id
                                                WHERE v.approval_id = ar.id
                                                  AND v.decision = 'approve'), '[]'::json))
                      ORDER BY ar.decided_at)
                       FROM approval_requests ar
                      WHERE ar.cycle_id = c.id AND ar.project_id = ${projectId}
                        AND ar.status = 'approved' AND ar.stage IS NOT NULL), '[]'::json) AS approvals
      FROM sdlc_cycles c
     WHERE c.project_id = ${projectId}
     ORDER BY c.number`.execute(tx);
  const cycleFacts: CycleFact[] = cycles.map((c) => ({
    number: c.number,
    title: c.title,
    stage: c.stage,
    status: c.status,
    createdDay: c.created_day,
    transitions: c.transitions,
    approvals: c.approvals.map((a) => ({
      stage: a.stage,
      day: a.day,
      approvers: a.approvers.map((n) => n ?? 'Former teammate'),
      artifactId: a.artifact_id,
    })),
  }));

  // The current stage's gate: who approves it and whether a request is waiting.
  const current = cycles.filter((c) => c.status === 'active').at(-1) ?? cycles.at(-1) ?? null;
  let gate: PlaybookFacts['gate'] = null;
  if (current && current.stage !== 'MAINTAIN') {
    const { rows } = await sql<{
      mode: string;
      roles: string[];
      pending: { approvals: number; required: number } | null;
    }>`
      SELECT g.mode::text AS mode,
             COALESCE((SELECT json_agg(r.name ORDER BY r.name) FROM project_roles r
                        WHERE r.id = ANY(g.approver_role_ids)), '[]'::json) AS roles,
             (SELECT json_build_object(
                       'approvals', (SELECT count(*)::int FROM approval_votes v
                                      WHERE v.approval_id = ar.id AND v.decision = 'approve'),
                       'required', ar.min_approvals)
                FROM approval_requests ar JOIN sdlc_cycles c ON c.id = ar.cycle_id
               WHERE ar.project_id = ${projectId} AND c.number = ${current.number}
                 AND ar.stage = g.stage AND ar.status = 'pending' AND ar.expires_at > now()
               ORDER BY ar.created_at DESC LIMIT 1) AS pending
        FROM stage_gate_policies g
       WHERE g.project_id = ${projectId} AND g.stage = ${current.stage}::sdlc_stage`.execute(tx);
    const g = rows[0];
    if (g) gate = { mode: g.mode, approverRoles: g.roles, pending: g.pending };
  }

  const members = (await listProjectMembers(tx, projectId)).map((m) => ({
    name: m.display_name,
    roles: m.roles.map((r) => r.name),
  }));

  // F-keys: every project file in order of its first version, deleted ones too, so a number never
  // moves. A member's context cannot see a deleted file's row (RLS), only its versions: those count
  // by the arena's org (one project per hidden org, ADR-029). The arena's own logs are left out.
  let files: FileFact[] = [];
  if (part === 'full') {
    const { rows } = await sql<FileRow>`
      WITH keyed AS (
        SELECT v1.artifact_id, row_number() OVER (ORDER BY v1.created_at, v1.artifact_id)::int AS n
          FROM artifact_versions v1
          LEFT JOIN artifacts a ON a.id = v1.artifact_id
         WHERE v1.version_no = 1
           AND v1.org_id = (SELECT org_id FROM projects WHERE id = ${projectId})
           AND (a.id IS NULL
                OR (a.project_id = ${projectId} AND a.scope = 'project'
                    AND a.kind NOT IN ('progress', 'stage_summary')))
      )
      SELECT k.n, a.id, a.name, a.stage::text AS stage, a.head_version_no, a.approved_version_no,
             to_char(a.updated_at AT TIME ZONE ${tz}, 'YYYY-MM-DD') AS updated_day,
             COALESCE((SELECT json_agg(DISTINCT CASE WHEN v.created_by_type = 'user'
                                                     THEN COALESCE(u.display_name, 'Former teammate')
                                                     ELSE 'AI' END)
                         FROM artifact_versions v
                         LEFT JOIN users u ON v.created_by_type = 'user' AND u.id = v.created_by
                        WHERE v.artifact_id = a.id), '[]'::json) AS authors
        FROM keyed k JOIN artifacts a ON a.id = k.artifact_id
       WHERE a.project_id = ${projectId} AND a.scope = 'project' AND a.deleted_at IS NULL
       ORDER BY k.n`.execute(tx);
    files = rows.map((f) => ({
      id: f.id,
      key: `F-${f.n}`,
      name: f.name,
      stage: f.stage,
      headVersion: f.head_version_no,
      approvedVersion: f.approved_version_no,
      authors: f.authors,
      updatedDay: f.updated_day,
    }));
  }

  const nodes = await loadNodes(tx, projectId);
  const edges = part === 'full' ? await loadEdges(tx, projectId) : [];
  const days = await loadDays(tx, projectId);
  const told = days.filter((d) => d.status !== 'pending');
  const story = [...told].reverse().find((d) => d.story)?.story ?? null;

  return {
    timezone: tz,
    facts: {
      arenaName: project.name,
      description: project.description,
      createdDay: project.created_day,
      cycles: cycleFacts,
      gate,
      members,
      files,
      // renderMemoryFiles knows (legacyState); the compact context does not link it.
      hasLegacy: false,
    },
    upTo: told.at(-1)?.day ?? null,
    story,
    nodes,
    edges,
  };
}

/**
 * Arena messages after the memory last told a day (the end of `upTo` in the arena's zone), newest
 * SINCE_MESSAGES, oldest first. Before the first night: the newest messages.
 */
export async function messagesSince(
  tx: Tx,
  input: { projectId: string; arenaId: string; upTo: string | null; timezone: string },
): Promise<RecentMessage[]> {
  const since = input.upTo ? (await dayBounds(tx, input.upTo, input.timezone)).until : null;
  const { rows } = await sql<{ name: string | null; author_type: string; body: string }>`
    SELECT u.display_name AS name, m.author_type::text AS author_type, m.body
      FROM (SELECT * FROM messages
             WHERE arena_id = ${input.arenaId} AND deleted_at IS NULL
               AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
             ORDER BY created_at DESC, id DESC LIMIT ${SINCE_MESSAGES}) m
      LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
     ORDER BY m.created_at, m.id`.execute(tx);
  return rows.map((m) => ({
    author: m.author_type === 'user' ? (m.name ?? 'Former teammate') : 'AI',
    text: m.body,
  }));
}
