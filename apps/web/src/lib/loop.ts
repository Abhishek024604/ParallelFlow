import { type GateApproval, type LoopState, nextStage } from '@saras/contracts';

// Client-side view of the loop (build step 7): the optimistic vote, shown at once and replaced by the
// server state on the next fetch. The server decides (min_approvals, distinct roles, self-approval).

export const approvalsOf = (approval: Pick<GateApproval, 'votes'>): number =>
  approval.votes.filter((v) => v.decision === 'approve').length;

/** The state as it will most likely be after the viewer's vote. */
export function applyVote(
  state: LoopState,
  approvalId: string,
  decision: 'approve' | 'reject',
  reason: string | null,
): LoopState {
  const now = new Date().toISOString();
  let moveTo: GateApproval['to_stage'] | null = null;
  const approvals = state.approvals.map((a) => {
    if (a.id !== approvalId || a.status !== 'pending') return a;
    const votes = [
      ...a.votes,
      { user_id: state.viewer.user_id, display_name: 'You', decision, reason, created_at: now },
    ];
    const met = decision === 'approve' && approvalsOf({ votes }) >= a.min_approvals;
    const status: GateApproval['status'] =
      decision === 'reject' ? 'rejected' : met ? 'approved' : 'pending';
    if (met) moveTo = a.to_stage;
    return { ...a, votes, status, decided_at: status === 'pending' ? null : now };
  });
  const pending = approvals.find((a) => a.id === state.pending?.id && a.status === 'pending');
  const to = moveTo as GateApproval['to_stage'] | null;
  const cycle =
    state.cycle && to
      ? {
          ...state.cycle,
          stage: to,
          status: to === 'MAINTAIN' ? ('operating' as const) : state.cycle.status,
        }
      : state.cycle;
  return {
    ...state,
    cycle,
    // The next stage's gate arrives with the server state.
    gate: to ? null : state.gate,
    approvals,
    pending: pending ?? null,
    viewer: to ? { ...state.viewer, can_request_gate: false, can_approve: false } : state.viewer,
  };
}

/** "PLAN gate · waiting on 1 approval". */
export function waitingLabel(approval: GateApproval): string {
  const left = Math.max(1, approval.min_approvals - approvalsOf(approval));
  return `${approval.stage} gate · waiting on ${left} approval${left === 1 ? '' : 's'}`;
}

export const movesLabel = (approval: GateApproval): string =>
  `Moves Cycle ${approval.cycle_number} from ${approval.stage} to ${approval.to_stage ?? nextStage(approval.stage)}`;
