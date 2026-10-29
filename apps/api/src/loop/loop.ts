import {
  earlierStages,
  handoffRecipients,
  type ApprovalStatus,
  type GateApproval,
  type GateRequest,
  type LoopActionResult,
  type LoopActor,
  type LoopState,
  type LoopTransition,
  type SdlcStage,
  type SendBack,
  uuidv7,
  type Vote,
} from '@parallelflow/contracts';
import { requireActiveArena } from '../arenas/arena-admin.js';
import {
  notify,
  requestStageGate,
  resolveNotifications,
  type StageGateOutcome,
  type Tx,
} from '@parallelflow/db';
import { sql } from 'kysely';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';
import { type CycleStatus, checkVote } from './gate-rules.js';

// The SDLC loop (build step 7): the stage strip's state, gate requests, votes and Send back. Every
// function runs in the pipeline's verified tenant transaction (@ProjectScoped) and keeps to as few
// round trips as it can: the state is one query; a vote or a Send back is one locking read and one
// write statement. Reasons and summaries are stored, never logged.

const approveCap = (stage: SdlcStage) => `stage.approve.${stage}`;

interface ApprovalRow {
  id: string;
  cycle_id: string;
  stage: SdlcStage;
  title: string;
  status: ApprovalStatus;
  min_approvals: number;
  detail: {
    requested_by?: LoopActor;
    cycle_number?: number;
    to?: SdlcStage;
  };
  approver_roles: string[];
  votes: GateApproval['votes'];
  created_at: string;
  expires_at: string;
  decided_at: string | null;
}

interface TransitionRow {
  from_stage: SdlcStage | null;
  to_stage: SdlcStage;
  kind: LoopTransition['kind'];
  actor_type: LoopActor['type'];
  actor_id: string;
  display_name: string | null;
  reason: string | null;
  created_at: string;
}

interface StateRow {
  cycle: NonNullable<LoopState['cycle']> | null;
  gate: (NonNullable<LoopState['gate']> & { approver_role_ids: string[] }) | null;
  approvals: ApprovalRow[];
  transitions: TransitionRow[];
  role_ids: string[];
  caps: string[];
}

const iso = (value: string | null): string | null => (value ? new Date(value).toISOString() : null);

function toApproval(row: ApprovalRow, cycleNumber: number): GateApproval {
  return {
    id: row.id,
    cycle_id: row.cycle_id,
    cycle_number: row.detail.cycle_number ?? cycleNumber,
    stage: row.stage,
    to_stage: row.detail.to ?? row.stage,
    title: row.title,
    status: row.status,
    min_approvals: row.min_approvals,
    approver_roles: row.approver_roles,
    requested_by: row.detail.requested_by ?? { type: 'user', id: '', display_name: 'A teammate' },
    votes: row.votes.map((v) => ({ ...v, created_at: iso(v.created_at) ?? v.created_at })),
    created_at: iso(row.created_at) ?? row.created_at,
    expires_at: iso(row.expires_at) ?? row.expires_at,
    decided_at: iso(row.decided_at),
  };
}

/** GET /projects/{project_id}/cycles/current: one query. */
export async function getLoopState(tx: Tx, projectId: string, userId: string): Promise<LoopState> {
  const { rows } = await sql<StateRow>`
    WITH c AS (
      SELECT id, number, title, stage, status FROM sdlc_cycles
       WHERE project_id = ${projectId}
       ORDER BY (status = 'active') DESC, number DESC LIMIT 1
    )
    SELECT
      (SELECT row_to_json(c) FROM c) AS cycle,
      (SELECT json_build_object(
                'stage', g.stage, 'mode', g.mode, 'min_approvals', g.min_approvals,
                'min_distinct_roles', g.min_distinct_roles,
                'forbid_self_approval', g.forbid_self_approval,
                'approver_role_ids', g.approver_role_ids,
                'approver_roles', COALESCE((SELECT json_agg(r.name ORDER BY r.name) FROM project_roles r
                                             WHERE r.id = ANY(g.approver_role_ids)), '[]'::json))
         FROM c JOIN stage_gate_policies g ON g.project_id = ${projectId} AND g.stage = c.stage
        WHERE c.stage <> 'MAINTAIN') AS gate,
      COALESCE((SELECT json_agg(a ORDER BY a.created_at DESC) FROM (
         SELECT ar.id, ar.cycle_id, ar.stage, ar.title, ar.min_approvals, ar.detail, ar.created_at,
                ar.expires_at, ar.decided_at,
                CASE WHEN ar.status = 'pending' AND ar.expires_at <= now() THEN 'expired'
                     ELSE ar.status::text END AS status,
                COALESCE((SELECT json_agg(r.name ORDER BY r.name) FROM project_roles r
                           WHERE r.id = ANY(ar.approver_role_ids)), '[]'::json) AS approver_roles,
                COALESCE((SELECT json_agg(json_build_object(
                                   'user_id', v.user_id, 'display_name', u.display_name,
                                   'decision', v.decision, 'reason', v.reason,
                                   'created_at', v.created_at) ORDER BY v.created_at)
                            FROM approval_votes v LEFT JOIN users u ON u.id = v.user_id
                           WHERE v.approval_id = ar.id), '[]'::json) AS votes
           FROM approval_requests ar JOIN c ON ar.cycle_id = c.id
          WHERE ar.project_id = ${projectId}
          ORDER BY ar.created_at DESC LIMIT 20) a), '[]'::json) AS approvals,
      COALESCE((SELECT json_agg(t ORDER BY t.created_at DESC) FROM (
         SELECT st.from_stage, st.to_stage, st.kind, st.actor_type, st.actor_id, st.reason,
                st.created_at, u.display_name
           FROM stage_transitions st JOIN c ON st.cycle_id = c.id
           LEFT JOIN users u ON st.actor_type = 'user' AND u.id = st.actor_id
          ORDER BY st.created_at DESC LIMIT 10) t), '[]'::json) AS transitions,
      COALESCE((SELECT array_agg(pmr.role_id::text) FROM project_member_roles pmr
                 WHERE pmr.project_id = ${projectId} AND pmr.user_id = ${userId}), '{}') AS role_ids,
      COALESCE((SELECT array_agg(mc.capability) FROM member_capabilities mc
                 WHERE mc.project_id = ${projectId} AND mc.user_id = ${userId}
                   AND mc.capability LIKE 'stage.%'), '{}') AS caps`.execute(tx);
  const row = rows[0];
  const cycle = row?.cycle ?? null;
  const caps = new Set(row?.caps ?? []);
  const approvals = cycle ? (row?.approvals ?? []).map((a) => toApproval(a, cycle.number)) : [];
  const gate = row?.gate ?? null;
  const pending =
    approvals.find((a) => a.status === 'pending' && cycle && a.stage === cycle.stage) ?? null;
  const roleIds = new Set(row?.role_ids ?? []);
  const active = cycle?.status === 'active';
  return {
    cycle,
    gate: gate && {
      stage: gate.stage,
      mode: gate.mode,
      approver_roles: gate.approver_roles,
      min_approvals: gate.min_approvals,
      min_distinct_roles: gate.min_distinct_roles,
      forbid_self_approval: gate.forbid_self_approval,
    },
    pending,
    approvals,
    transitions: (row?.transitions ?? []).map((t) => ({
      from_stage: t.from_stage,
      to_stage: t.to_stage,
      kind: t.kind,
      actor: {
        type: t.actor_type,
        id: t.actor_id,
        display_name: t.actor_type === 'user' ? (t.display_name ?? 'Former teammate') : 'AI',
      },
      reason: t.reason,
      created_at: iso(t.created_at) ?? t.created_at,
    })),
    viewer: {
      user_id: userId,
      can_request_gate: active && Boolean(gate) && caps.has('stage.request_gate'),
      can_approve:
        active &&
        Boolean(gate && cycle) &&
        caps.has(approveCap(cycle?.stage ?? 'PLAN')) &&
        (gate?.approver_role_ids ?? []).some((id) => roleIds.has(id)),
    },
  };
}

/** Maps a refused gate request to its API error. */
export function gateRefusal(reason: Exclude<StageGateOutcome, { ok: true }>['reason']): ApiError {
  switch (reason) {
    case 'FORBIDDEN':
      return new ApiError(403, 'FORBIDDEN', {
        detail: 'You cannot request stage gates in this arena.',
        requiredPermission: 'cap stage.request_gate',
      });
    case 'NO_CYCLE':
    case 'CYCLE_MISMATCH':
      return new ApiError(409, 'WRONG_STAGE', { detail: 'This cycle is not the active one.' });
    case 'NO_GATE':
      return new ApiError(409, 'WRONG_STAGE', { detail: 'This stage has no gate to request.' });
    case 'NOT_APPROVAL':
      return new ApiError(422, 'PRECONDITION_FAILED', {
        detail: 'This stage moves on without approval.',
      });
    case 'PENDING':
      return new ApiError(409, 'CONFLICT', {
        detail: 'This gate is already waiting for approval.',
      });
  }
}

/** The Push dialog's "Request the <STAGE> gate": the stage when you could request it now (one query). */
export async function gateAvailable(
  tx: Tx,
  projectId: string,
  userId: string,
): Promise<{ stage: SdlcStage; cycle_number: number } | null> {
  const { rows } = await sql<{ stage: SdlcStage; cycle_number: number }>`
    SELECT c.stage, c.number AS cycle_number
      FROM sdlc_cycles c
      JOIN stage_gate_policies g ON g.project_id = c.project_id AND g.stage = c.stage
                                AND g.mode = 'approval'
     WHERE c.project_id = ${projectId} AND c.status = 'active' AND c.stage <> 'MAINTAIN'
       AND EXISTS (SELECT 1 FROM member_capabilities mc
                    WHERE mc.project_id = c.project_id AND mc.user_id = ${userId}
                      AND mc.capability = 'stage.request_gate')
       AND NOT EXISTS (SELECT 1 FROM approval_requests ar
                        WHERE ar.cycle_id = c.id AND ar.stage = c.stage AND ar.status = 'pending'
                          AND ar.expires_at > now())`.execute(tx);
  return rows[0] ?? null;
}

/** POST /projects/{project_id}/cycles/{cycle_id}/gate-requests (cap stage.request_gate). */
export async function requestGate(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  cycleId: string | undefined,
  input: GateRequest,
): Promise<LoopActionResult> {
  await requireActiveArena(tx, ctx.projectId);
  const out = await requestStageGate(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actor: { type: 'user', id: ctx.userId },
    ...(cycleId && { cycleId }),
    summary: input.summary ?? null,
    artifactId: input.artifact_id ?? null,
    requireCapability: true,
  });
  if (!out.ok) throw gateRefusal(out.reason);
  return {
    approval_id: out.approvalId,
    approval_status: 'pending',
    approvals: 0,
    cycle_number: out.cycleNumber,
    stage: out.stage,
    cycle_status: 'active',
  };
}

interface VoteRow {
  cycle_id: string;
  stage: SdlcStage;
  status: string;
  expired: boolean;
  min_approvals: number;
  requested_by: string | null;
  cycle_stage: SdlcStage;
  cycle_number: number;
  cycle_status: CycleStatus;
  forbid_self_approval: boolean | null;
  min_distinct_roles: number | null;
  has_cap: boolean;
  my_roles: string[];
  votes: { user_id: string; decision: 'approve' | 'reject'; roles: string[] }[];
  artifact_id: string | null;
  summary: string | null;
}

/** A gate that just passed (voteOnGate's onAdvance, called inside the vote's transaction). */
export interface GateAdvance {
  approvalId: string;
  cycleNumber: number;
  fromStage: SdlcStage;
  toStage: SdlcStage;
  summary: string | null;
}

/** POST /projects/{project_id}/approvals/{approval_id}/votes: a person's vote (two round trips). */
export async function voteOnGate(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  approvalId: string,
  input: Vote,
  onAdvance?: (advance: GateAdvance) => Promise<void>,
): Promise<LoopActionResult> {
  // The request and its cycle are locked: votes on one gate, and gate moves, run one at a time.
  const { rows } = await sql<VoteRow>`
    SELECT ar.cycle_id, ar.stage, ar.status::text AS status, ar.expires_at <= now() AS expired,
           ar.min_approvals, ar.detail #>> '{requested_by,id}' AS requested_by,
           ar.detail ->> 'artifact_id' AS artifact_id, ar.detail ->> 'summary' AS summary,
           c.stage AS cycle_stage, c.number AS cycle_number, c.status AS cycle_status,
           g.forbid_self_approval, g.min_distinct_roles,
           EXISTS (SELECT 1 FROM member_capabilities mc
                    WHERE mc.project_id = ${ctx.projectId} AND mc.user_id = ${ctx.userId}
                      AND mc.capability = 'stage.approve.' || ar.stage::text) AS has_cap,
           COALESCE((SELECT array_agg(pmr.role_id::text) FROM project_member_roles pmr
                      WHERE pmr.project_id = ${ctx.projectId} AND pmr.user_id = ${ctx.userId}
                        AND pmr.role_id = ANY(ar.approver_role_ids)), '{}') AS my_roles,
           COALESCE((SELECT json_agg(json_build_object(
                              'user_id', v.user_id, 'decision', v.decision,
                              'roles', COALESCE((SELECT json_agg(pmr.role_id) FROM project_member_roles pmr
                                                  WHERE pmr.project_id = ${ctx.projectId}
                                                    AND pmr.user_id = v.user_id
                                                    AND pmr.role_id = ANY(ar.approver_role_ids)),
                                                '[]'::json)))
                       FROM approval_votes v WHERE v.approval_id = ar.id), '[]'::json) AS votes
      FROM approval_requests ar
      JOIN sdlc_cycles c ON c.id = ar.cycle_id
      LEFT JOIN stage_gate_policies g ON g.project_id = ar.project_id AND g.stage = ar.stage
     WHERE ar.id = ${approvalId} AND ar.project_id = ${ctx.projectId}
       FOR UPDATE OF ar, c`.execute(tx);
  const row = rows[0];
  if (!row) throw notFound();

  const check = checkVote({
    decision: input.decision,
    status: row.status,
    expired: row.expired,
    requestStage: row.stage,
    cycleStage: row.cycle_stage,
    cycleStatus: row.cycle_status,
    hasCapability: row.has_cap,
    approverRolesHeld: row.my_roles,
    isRequester: row.requested_by === ctx.userId,
    forbidSelfApproval: row.forbid_self_approval ?? false,
    alreadyVoted: row.votes.some((v) => v.user_id === ctx.userId),
    priorApprovals: row.votes.filter((v) => v.decision === 'approve'),
    minApprovals: row.min_approvals,
    minDistinctRoles: row.min_distinct_roles ?? 1,
  });
  if (!check.ok) {
    throw new ApiError(check.status, check.code, {
      detail: check.detail,
      ...(check.status === 403 && { requiredPermission: `cap ${approveCap(row.stage)}` }),
    });
  }

  const decided = check.outcome !== 'pending';
  const advance = check.advance;
  // One statement: the vote, the request's decision, the cycle move and its transition.
  await sql`
    WITH vote AS (
      INSERT INTO approval_votes (org_id, approval_id, user_id, decision, reason)
      VALUES (${ctx.orgId}, ${approvalId}, ${ctx.userId}, ${input.decision}, ${input.reason ?? null})
      RETURNING approval_id
    ), decide AS (
      UPDATE approval_requests SET status = ${check.outcome}::approval_status, decided_at = now()
       WHERE id = ${approvalId} AND ${decided}::boolean
      RETURNING id
    ), moved AS (
      UPDATE sdlc_cycles
         SET stage = ${advance?.toStage ?? row.stage}::sdlc_stage,
             status = ${advance?.cycleStatus ?? row.cycle_status}::cycle_status,
             updated_at = now(), version = version + 1
       WHERE id = ${row.cycle_id} AND stage = ${row.stage}::sdlc_stage AND ${Boolean(advance)}::boolean
      RETURNING id
    )
    INSERT INTO stage_transitions (org_id, cycle_id, from_stage, to_stage, kind, actor_type, actor_id,
                                   approvals)
    SELECT ${ctx.orgId}, moved.id, ${row.stage}::sdlc_stage,
           ${advance?.toStage ?? row.stage}::sdlc_stage, 'advance', 'user', ${ctx.userId},
           ARRAY[${approvalId}]::uuid[]
      FROM moved, vote`.execute(tx);

  if (decided) {
    // The approvers' Inbox items are done; the arena hears the decision. When the loop moves on,
    // the people who work in the next stage get the handoff instead (notifyHandoff).
    await resolveNotifications(tx, { projectId: ctx.projectId, resourceId: approvalId });
    const handoff = advance
      ? await notifyHandoff(tx, ctx, {
          approvalId,
          fromStage: row.stage,
          toStage: advance.toStage,
        })
      : null;
    if (!handoff || 'roleIds' in handoff) {
      await notify(tx, {
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        type: 'stage_update',
        title: advance
          ? `${row.stage} approved · the cycle moved to ${advance.toStage}`
          : `${row.stage} gate was not approved`,
        preview: advance ? row.summary : (input.reason ?? null),
        resourceType: 'approval_request',
        resourceId: approvalId,
        deepLink: `/arena/${ctx.projectId}`,
        actor: { type: 'user', id: ctx.userId },
        dedupeKey: `gate-decided:${approvalId}`,
        recipients: handoff
          ? { userIds: await membersOutsideRoles(tx, ctx.projectId, handoff.roleIds) }
          : { members: true },
      });
    }
  }

  if (advance) {
    // Humans close the loop: the gate's document (if one was attached) is approved at its latest
    // version by this approval.
    if (row.artifact_id) {
      await sql`
        WITH a AS (
          UPDATE artifacts SET approved_version_no = head_version_no, updated_at = now()
           WHERE id = ${row.artifact_id}::uuid AND project_id = ${ctx.projectId} AND scope = 'project'
          RETURNING id, head_version_no
        )
        UPDATE artifact_versions v
           SET status = 'approved', approved_by = ${ctx.userId}, approved_at = now()
          FROM a WHERE v.artifact_id = a.id AND v.version_no = a.head_version_no`.execute(tx);
    }
    await onAdvance?.({
      approvalId,
      cycleNumber: row.cycle_number,
      fromStage: row.stage,
      toStage: advance.toStage,
      summary: row.summary,
    });
  }

  return {
    approval_id: approvalId,
    approval_status: check.outcome,
    approvals: check.approvals,
    cycle_number: row.cycle_number,
    stage: advance?.toStage ?? row.stage,
    cycle_status: advance?.cycleStatus ?? row.cycle_status,
  };
}

/** "PLAN" → "Plan". */
export const stageName = (stage: SdlcStage) => stage.charAt(0) + stage.slice(1).toLowerCase();

/** The handoff's Inbox link: the Private home offers "Open in a private chat" with the files. */
export const handoffLink = (projectId: string, approvalId: string) =>
  `/private?handoff=${encodeURIComponent(approvalId)}&arena=${encodeURIComponent(projectId)}`;

/**
 * Stage handoff (ADR-041): "<Stage> approved: start <Next>" for the members whose roles work in the
 * next stage, or every member when no role does. Returns who was told.
 */
async function notifyHandoff(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  input: { approvalId: string; fromStage: SdlcStage; toStage: SdlcStage },
): Promise<{ roleIds: string[] } | { members: true }> {
  const { rows } = await sql<{ id: string; stages: SdlcStage[] | null }>`
    SELECT id, stages::text[] AS stages FROM project_roles
     WHERE project_id = ${ctx.projectId}`.execute(tx);
  const recipients = handoffRecipients(
    rows.map((r) => ({ id: r.id, stages: r.stages ?? [] })),
    input.toStage,
  );
  await notify(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'stage_update',
    title: `${stageName(input.fromStage)} approved: start ${stageName(input.toStage)}`,
    preview: 'Open in a private chat with the approved files',
    resourceType: 'approval_request',
    resourceId: input.approvalId,
    deepLink: handoffLink(ctx.projectId, input.approvalId),
    // No actor: the approver who also works in the next stage gets the handoff too.
    actor: null,
    dedupeKey: `handoff:${input.approvalId}`,
    recipients,
  });
  return recipients;
}

/** Active members of the project holding none of these roles. */
async function membersOutsideRoles(
  tx: Tx,
  projectId: string,
  roleIds: readonly string[],
): Promise<string[]> {
  const { rows } = await sql<{ user_id: string }>`
    SELECT pm.user_id FROM project_members pm
     WHERE pm.project_id = ${projectId}
       AND NOT EXISTS (SELECT 1 FROM project_member_roles pmr
                        WHERE pmr.project_id = pm.project_id AND pmr.user_id = pm.user_id
                          AND pmr.role_id = ANY(${[...roleIds]}::uuid[]))`.execute(tx);
  return rows.map((r) => r.user_id);
}

interface SendBackRow {
  number: number;
  stage: SdlcStage;
  allowed: boolean;
  pending_id: string | null;
}

/**
 * POST /projects/{project_id}/cycles/{cycle_id}:send-back: a gate approver of the current stage moves
 * the cycle to an earlier stage with a reason; an open gate request of this stage is cancelled.
 */
export async function sendBack(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  cycleId: string,
  input: SendBack,
): Promise<LoopActionResult> {
  const { rows } = await sql<SendBackRow>`
    SELECT c.number, c.stage,
           (EXISTS (SELECT 1 FROM member_capabilities mc
                     WHERE mc.project_id = c.project_id AND mc.user_id = ${ctx.userId}
                       AND mc.capability = 'stage.approve.' || c.stage::text)
            AND EXISTS (SELECT 1 FROM project_member_roles pmr
                         WHERE pmr.project_id = c.project_id AND pmr.user_id = ${ctx.userId}
                           AND pmr.role_id = ANY(g.approver_role_ids))) AS allowed,
           (SELECT ar.id FROM approval_requests ar
             WHERE ar.cycle_id = c.id AND ar.stage = c.stage AND ar.status = 'pending'
             LIMIT 1) AS pending_id
      FROM sdlc_cycles c
      LEFT JOIN stage_gate_policies g ON g.project_id = c.project_id AND g.stage = c.stage
     WHERE c.id = ${cycleId} AND c.project_id = ${ctx.projectId} AND c.status = 'active'
       FOR UPDATE OF c`.execute(tx);
  const row = rows[0];
  if (!row) throw new ApiError(409, 'WRONG_STAGE', { detail: 'This cycle is not the active one.' });
  if (!row.allowed) {
    throw new ApiError(403, 'FORBIDDEN', {
      detail: `Only the ${row.stage} gate approvers can send the cycle back.`,
      requiredPermission: `cap ${approveCap(row.stage)}`,
    });
  }
  const earlier = earlierStages(row.stage);
  const toStage = input.to_stage ?? earlier.at(-1);
  if (!toStage || !earlier.includes(toStage)) {
    throw validationFailed(
      [{ field: 'to_stage', message: 'Pick an earlier stage' }],
      `${row.stage} has no earlier stage to go back to.`,
    );
  }

  await sql`
    WITH cancelled AS (
      UPDATE approval_requests SET status = 'cancelled', decided_at = now()
       WHERE id = ${row.pending_id}::uuid
      RETURNING id
    ), moved AS (
      UPDATE sdlc_cycles SET stage = ${toStage}::sdlc_stage, updated_at = now(), version = version + 1
       WHERE id = ${cycleId}
      RETURNING id
    )
    INSERT INTO stage_transitions (org_id, cycle_id, from_stage, to_stage, kind, actor_type, actor_id,
                                   reason)
    SELECT ${ctx.orgId}, moved.id, ${row.stage}::sdlc_stage, ${toStage}::sdlc_stage, 'send_back',
           'user', ${ctx.userId}, ${input.reason}
      FROM moved`.execute(tx);

  if (row.pending_id) {
    await resolveNotifications(tx, { projectId: ctx.projectId, resourceId: row.pending_id });
  }
  await notify(tx, {
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    type: 'stage_update',
    title: `Cycle ${row.number} was sent back to ${toStage}`,
    preview: input.reason,
    resourceType: 'cycle',
    resourceId: cycleId,
    deepLink: `/arena/${ctx.projectId}`,
    actor: { type: 'user', id: ctx.userId },
    dedupeKey: `send-back:${uuidv7()}`,
    recipients: { members: true },
  });

  return {
    approval_id: row.pending_id,
    approval_status: row.pending_id ? 'cancelled' : null,
    approvals: 0,
    cycle_number: row.number,
    stage: toStage,
    cycle_status: 'active',
  };
}
