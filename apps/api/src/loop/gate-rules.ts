import { type ErrorCode, nextStage, type SdlcStage } from '@saras/contracts';

// The stage gate rules (CLAUDE.md rules 4 and 5), pure so they are unit tested without a database.
// Phase A: the gate's approvers are the people holding one of its approver roles (default Owner) and
// stage.approve.<stage>. Votes come from people only: the AI has no vote tool.

export type CycleStatus = 'active' | 'operating' | 'closed' | 'abandoned';

/** Where approving a gate takes the cycle: the next stage; MAINTAIN means the cycle is operating. */
export function advanceFrom(stage: SdlcStage): { toStage: SdlcStage; cycleStatus: CycleStatus } {
  const toStage = nextStage(stage);
  if (!toStage) throw new Error('MAINTAIN has no gate');
  return { toStage, cycleStatus: toStage === 'MAINTAIN' ? 'operating' : 'active' };
}

export interface VoteFacts {
  decision: 'approve' | 'reject';
  /** approval_requests.status, and whether it is past expires_at. */
  status: string;
  expired: boolean;
  requestStage: SdlcStage;
  cycleStage: SdlcStage;
  cycleStatus: CycleStatus;
  /** The voter holds stage.approve.<requestStage>. */
  hasCapability: boolean;
  /** The gate's approver roles the voter holds. */
  approverRolesHeld: readonly string[];
  isRequester: boolean;
  forbidSelfApproval: boolean;
  alreadyVoted: boolean;
  /** Approve votes already cast, with each voter's approver roles. */
  priorApprovals: readonly { roles: readonly string[] }[];
  minApprovals: number;
  minDistinctRoles: number;
}

export type VoteCheck =
  | { ok: false; status: 403 | 409; code: ErrorCode; detail: string }
  | {
      ok: true;
      /** The request after this vote. */
      outcome: 'pending' | 'approved' | 'rejected';
      approvals: number;
      /** Set when the cycle moves. */
      advance: { toStage: SdlcStage; cycleStatus: CycleStatus } | null;
    };

export function checkVote(f: VoteFacts): VoteCheck {
  if (f.status !== 'pending' || f.expired) {
    return {
      ok: false,
      status: 409,
      code: 'APPROVAL_CLOSED',
      detail:
        f.expired && f.status === 'pending'
          ? 'This request has expired.'
          : 'This request is already decided.',
    };
  }
  if (f.cycleStatus !== 'active' || f.cycleStage !== f.requestStage) {
    return { ok: false, status: 409, code: 'WRONG_STAGE', detail: 'The cycle has moved on.' };
  }
  if (!f.hasCapability || f.approverRolesHeld.length === 0) {
    return {
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      detail: `Only the ${f.requestStage} gate approvers can do this.`,
    };
  }
  if (f.decision === 'approve' && f.isRequester && f.forbidSelfApproval) {
    return {
      ok: false,
      status: 403,
      code: 'SELF_APPROVAL_FORBIDDEN',
      detail: 'You requested this gate, so another approver must approve it.',
    };
  }
  if (f.alreadyVoted) {
    return { ok: false, status: 409, code: 'CONFLICT', detail: 'You have already voted.' };
  }
  if (f.decision === 'reject') {
    return { ok: true, outcome: 'rejected', approvals: f.priorApprovals.length, advance: null };
  }
  const approvers = [...f.priorApprovals, { roles: f.approverRolesHeld }];
  const roles = new Set(approvers.flatMap((a) => a.roles));
  const met = approvers.length >= f.minApprovals && roles.size >= f.minDistinctRoles;
  return {
    ok: true,
    outcome: met ? 'approved' : 'pending',
    approvals: approvers.length,
    advance: met ? advanceFrom(f.requestStage) : null,
  };
}
