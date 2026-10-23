import type { GateApproval, LoopState } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { applyVote, waitingLabel } from './loop';

const approval: GateApproval = {
  id: 'a1',
  cycle_id: 'c1',
  cycle_number: 1,
  stage: 'PLAN',
  to_stage: 'DESIGN',
  title: 'PLAN gate',
  status: 'pending',
  min_approvals: 1,
  approver_roles: ['Owner'],
  requested_by: { type: 'user', id: 'u2', display_name: 'Riya' },
  votes: [],
  created_at: '2026-10-17T10:00:00.000Z',
  expires_at: '2026-10-24T10:00:00.000Z',
  decided_at: null,
};

const state: LoopState = {
  cycle: { id: 'c1', number: 1, title: 'Cycle 1', stage: 'PLAN', status: 'active' },
  gate: {
    stage: 'PLAN',
    mode: 'approval',
    approver_roles: ['Owner'],
    min_approvals: 1,
    min_distinct_roles: 1,
    forbid_self_approval: false,
  },
  pending: approval,
  approvals: [approval],
  transitions: [],
  viewer: { user_id: 'u1', can_request_gate: true, can_approve: true },
};

describe('applyVote', () => {
  it('an approval that meets min_approvals moves the stage at once', () => {
    const next = applyVote(state, 'a1', 'approve', null);
    expect(next.cycle?.stage).toBe('DESIGN');
    expect(next.pending).toBeNull();
    expect(next.approvals[0]?.status).toBe('approved');
    expect(next.viewer.can_approve).toBe(false);
  });

  it('waits when more approvals are needed', () => {
    const two = { ...approval, min_approvals: 2 };
    const next = applyVote({ ...state, pending: two, approvals: [two] }, 'a1', 'approve', null);
    expect(next.cycle?.stage).toBe('PLAN');
    expect(next.pending?.votes).toHaveLength(1);
    expect(waitingLabel(next.pending ?? two)).toBe('PLAN gate · waiting on 1 approval');
  });

  it('a send back closes the request and keeps the stage', () => {
    const next = applyVote(state, 'a1', 'reject', 'Needs the rubric owner');
    expect(next.cycle?.stage).toBe('PLAN');
    expect(next.pending).toBeNull();
    expect(next.approvals[0]?.status).toBe('rejected');
  });
});
