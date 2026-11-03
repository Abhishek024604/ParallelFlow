import { GATE_REQUEST_TTL_DAYS, nextStage, type SdlcStage, uuidv7 } from '@parallelflow/contracts';
import { sql } from 'kysely';
import type { Tx } from './database.js';
import { recordArenaEvent } from './events.js';
import { notify } from './notifications.js';

// Stage gate requests (build step 7), shared by the API (people, Push) and App Tools (the AI's
// stage.request_gate). Two round trips in the caller's tenant transaction:
//   1. the active cycle (row locked, so two requests for one gate queue up), its gate policy, the
//      arena, whether a request is open, and optionally whether a person holds stage.request_gate;
//   2. one statement: the arena stream lock, the approval_requests row (only if none is open:
//      checked again under the lock) and its gate card in the stream, which has the same id.
// The card body is plain text ("PLAN gate requested by Riya"); the live state (votes, status) is read
// from approval_requests by id. Nothing here logs content.

export const STAGE_REQUEST_GATE = 'stage.request_gate';

export interface GateRequestActor {
  type: 'user' | 'agent';
  /** users.id or agents.id. */
  id: string;
}

export interface StageGateInput {
  orgId: string;
  projectId: string;
  actor: GateRequestActor;
  /** The cycle the caller saw (path id): a different active cycle is a conflict. */
  cycleId?: string;
  summary?: string | null;
  artifactId?: string | null;
  turnId?: string | null;
  /** Check that this person holds stage.request_gate in the same read. */
  requireCapability?: boolean;
}

export type StageGateOutcome =
  | {
      ok: true;
      approvalId: string;
      cycleId: string;
      cycleNumber: number;
      stage: SdlcStage;
      toStage: SdlcStage;
      minApprovals: number;
      approverRoles: string[];
    }
  | {
      ok: false;
      reason: 'FORBIDDEN' | 'NO_CYCLE' | 'CYCLE_MISMATCH' | 'NO_GATE' | 'NOT_APPROVAL' | 'PENDING';
    };

interface GateRow {
  cycle_id: string;
  number: number;
  stage: SdlcStage;
  arena_id: string;
  mode: 'approval' | 'auto' | 'skip' | null;
  approver_role_ids: string[] | null;
  min_approvals: number | null;
  approver_roles: string[];
  pending: boolean;
  allowed: boolean;
  actor_name: string | null;
}

/** Card text: "PLAN gate requested by Riya". */
export const gateCardBody = (stage: SdlcStage, by: string): string =>
  `${stage} gate requested by ${by}`;

export async function requestStageGate(tx: Tx, input: StageGateInput): Promise<StageGateOutcome> {
  const checkUser = input.requireCapability && input.actor.type === 'user' ? input.actor.id : null;
  const { rows } = await sql<GateRow>`
    SELECT c.id AS cycle_id, c.number, c.stage, a.id AS arena_id,
           g.mode, g.approver_role_ids::text[] AS approver_role_ids, g.min_approvals,
           COALESCE((SELECT array_agg(r.name ORDER BY r.name) FROM project_roles r
                      WHERE r.id = ANY(g.approver_role_ids)), '{}') AS approver_roles,
           EXISTS (SELECT 1 FROM approval_requests ar
                    WHERE ar.cycle_id = c.id AND ar.stage = c.stage AND ar.status = 'pending'
                      AND ar.expires_at > now()) AS pending,
           (${checkUser}::uuid IS NULL OR EXISTS (
              SELECT 1 FROM member_capabilities mc
               WHERE mc.project_id = c.project_id AND mc.user_id = ${checkUser}::uuid
                 AND mc.capability = ${STAGE_REQUEST_GATE})) AS allowed,
           (SELECT u.display_name FROM users u
             WHERE ${input.actor.type} = 'user' AND u.id = ${input.actor.id}::uuid) AS actor_name
      FROM sdlc_cycles c
      JOIN arenas a ON a.project_id = c.project_id
      LEFT JOIN stage_gate_policies g ON g.project_id = c.project_id AND g.stage = c.stage
     WHERE c.project_id = ${input.projectId} AND c.status = 'active'
       FOR UPDATE OF c`.execute(tx);
  const row = rows[0];
  if (row && !row.allowed) return { ok: false, reason: 'FORBIDDEN' };
  if (!row) return { ok: false, reason: 'NO_CYCLE' };
  if (input.cycleId && input.cycleId !== row.cycle_id)
    return { ok: false, reason: 'CYCLE_MISMATCH' };
  const toStage = nextStage(row.stage);
  if (!toStage || !row.mode || !row.approver_role_ids?.length) {
    return { ok: false, reason: 'NO_GATE' };
  }
  if (row.mode !== 'approval') return { ok: false, reason: 'NOT_APPROVAL' };
  if (row.pending) return { ok: false, reason: 'PENDING' };

  const id = uuidv7();
  const by = input.actor.type === 'user' ? (row.actor_name ?? 'A teammate') : 'AI';
  // Ids, names and the requester's own summary; read back by the stage strip and the cards.
  const detail = {
    kind: 'stage_gate',
    requested_by: { type: input.actor.type, id: input.actor.id, display_name: by },
    cycle_number: row.number,
    from: row.stage,
    to: toStage,
    summary: input.summary || null,
    artifact_id: input.artifactId ?? null,
  };
  const { rows: inserted } = await sql<{ id: string }>`
    WITH lock AS (
      SELECT pg_advisory_xact_lock(hashtextextended(${`arena-messages:${row.arena_id}`}, 0)) AS held
    ), request AS (
      INSERT INTO approval_requests (id, org_id, project_id, cycle_id, stage, turn_id, title, detail,
                                     approver_role_ids, min_approvals, expires_at)
      SELECT ${id}, ${input.orgId}, ${input.projectId}, ${row.cycle_id}, ${row.stage}::sdlc_stage,
             ${input.turnId ?? null}, ${`${row.stage} gate`}, ${JSON.stringify(detail)}::jsonb,
             ${row.approver_role_ids}::uuid[], ${row.min_approvals ?? 1},
             now() + make_interval(days => ${GATE_REQUEST_TTL_DAYS})
        FROM lock
       WHERE NOT EXISTS (SELECT 1 FROM approval_requests ar
                          WHERE ar.cycle_id = ${row.cycle_id} AND ar.stage = ${row.stage}::sdlc_stage
                            AND ar.status = 'pending' AND ar.expires_at > now())
      RETURNING id
    )
    INSERT INTO messages (id, created_at, org_id, arena_id, author_type, author_id, body, turn_id)
    SELECT request.id, clock_timestamp(), ${input.orgId}, ${row.arena_id},
           ${input.actor.type}::principal_type, ${input.actor.id}, ${gateCardBody(row.stage, by)},
           ${input.turnId ?? null}
      FROM request
    RETURNING id`.execute(tx);
  if (!inserted[0]) return { ok: false, reason: 'PENDING' };
  await recordArenaEvent(tx, { orgId: input.orgId, projectId: input.projectId }, input.actor, {
    action: input.actor.type === 'agent' ? 'ai.gate.requested' : 'loop.gate.requested',
    target: { type: 'approval', id },
    metadata: {
      stage: row.stage,
      to: toStage,
      cycle: row.number,
      required: row.min_approvals ?? 1,
      file_id: input.artifactId ?? undefined,
    },
  });
  // The stage's approvers get an Inbox item that needs their action (resolved when it is decided).
  await notify(tx, {
    orgId: input.orgId,
    projectId: input.projectId,
    type: 'approval_request',
    title: `${row.stage} gate needs your approval`,
    preview: input.summary || `Requested by ${by} · moves the cycle to ${toStage}`,
    resourceType: 'approval_request',
    resourceId: id,
    deepLink: `/arena/${input.projectId}`,
    actor: input.actor,
    requiresAction: true,
    dedupeKey: `gate-request:${id}`,
    recipients: { roleIds: row.approver_role_ids },
  });
  return {
    ok: true,
    approvalId: id,
    cycleId: row.cycle_id,
    cycleNumber: row.number,
    stage: row.stage,
    toStage,
    minApprovals: row.min_approvals ?? 1,
    approverRoles: row.approver_roles,
  };
}
