import { describe, expect, it } from 'vitest';
import { advanceFrom, checkVote, type VoteFacts } from './gate-rules.js';

const base: VoteFacts = {
  decision: 'approve',
  status: 'pending',
  expired: false,
  requestStage: 'PLAN',
  cycleStage: 'PLAN',
  cycleStatus: 'active',
  hasCapability: true,
  approverRolesHeld: ['owner-role'],
  isRequester: false,
  forbidSelfApproval: false,
  alreadyVoted: false,
  priorApprovals: [],
  minApprovals: 1,
  minDistinctRoles: 1,
};

describe('advanceFrom', () => {
  it('walks PLAN → DESIGN → BUILD → TEST → DEPLOY → MAINTAIN', () => {
    expect(advanceFrom('PLAN')).toEqual({ toStage: 'DESIGN', cycleStatus: 'active' });
    expect(advanceFrom('DESIGN').toStage).toBe('BUILD');
    expect(advanceFrom('BUILD').toStage).toBe('TEST');
    expect(advanceFrom('TEST').toStage).toBe('DEPLOY');
  });
  it('DEPLOY → MAINTAIN makes the cycle operating', () => {
    expect(advanceFrom('DEPLOY')).toEqual({ toStage: 'MAINTAIN', cycleStatus: 'operating' });
  });
  it('MAINTAIN has no gate', () => {
    expect(() => advanceFrom('MAINTAIN')).toThrow();
  });
});

describe('checkVote', () => {
  it('one approval from an approver advances the cycle', () => {
    expect(checkVote(base)).toEqual({
      ok: true,
      outcome: 'approved',
      approvals: 1,
      advance: { toStage: 'DESIGN', cycleStatus: 'active' },
    });
  });

  it('waits for min_approvals', () => {
    const r = checkVote({ ...base, minApprovals: 2 });
    expect(r).toMatchObject({ ok: true, outcome: 'pending', approvals: 1, advance: null });
    const second = checkVote({
      ...base,
      minApprovals: 2,
      priorApprovals: [{ roles: ['owner-role'] }],
    });
    expect(second).toMatchObject({ ok: true, outcome: 'approved', approvals: 2 });
  });

  it('needs min_distinct_roles different roles', () => {
    const sameRole = checkVote({
      ...base,
      minApprovals: 2,
      minDistinctRoles: 2,
      priorApprovals: [{ roles: ['owner-role'] }],
    });
    expect(sameRole).toMatchObject({ ok: true, outcome: 'pending' });
    const twoRoles = checkVote({
      ...base,
      minApprovals: 2,
      minDistinctRoles: 2,
      priorApprovals: [{ roles: ['lead'] }],
    });
    expect(twoRoles).toMatchObject({ ok: true, outcome: 'approved' });
  });

  it('a reject decides the request without moving the cycle', () => {
    expect(checkVote({ ...base, decision: 'reject' })).toEqual({
      ok: true,
      outcome: 'rejected',
      approvals: 0,
      advance: null,
    });
  });

  it('denies people who are not gate approvers', () => {
    expect(checkVote({ ...base, hasCapability: false })).toMatchObject({ ok: false, status: 403 });
    expect(checkVote({ ...base, approverRolesHeld: [] })).toMatchObject({ ok: false, status: 403 });
  });

  it('blocks self-approval only when the gate forbids it', () => {
    expect(checkVote({ ...base, isRequester: true })).toMatchObject({ ok: true });
    expect(checkVote({ ...base, isRequester: true, forbidSelfApproval: true })).toMatchObject({
      ok: false,
      code: 'SELF_APPROVAL_FORBIDDEN',
    });
    // The requester may still send it back.
    expect(
      checkVote({ ...base, isRequester: true, forbidSelfApproval: true, decision: 'reject' }),
    ).toMatchObject({ ok: true, outcome: 'rejected' });
  });

  it('refuses closed, expired, moved-on and repeated votes', () => {
    expect(checkVote({ ...base, status: 'approved' })).toMatchObject({ code: 'APPROVAL_CLOSED' });
    expect(checkVote({ ...base, expired: true })).toMatchObject({ code: 'APPROVAL_CLOSED' });
    expect(checkVote({ ...base, cycleStage: 'DESIGN' })).toMatchObject({ code: 'WRONG_STAGE' });
    expect(checkVote({ ...base, alreadyVoted: true })).toMatchObject({ code: 'CONFLICT' });
  });
});
