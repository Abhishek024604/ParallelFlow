import { findRoleTemplate } from '@parallelflow/contracts/role-templates';
import { describe, expect, it } from 'vitest';
import {
  checkDeleteRole,
  checkMemberRoles,
  checkRoleEdit,
  grantError,
  roleKey,
  ungrantable,
  unstaffedGates,
} from './role-rules.js';
import { planTemplate } from './roles.js';

const QA = 'qa';
const OWNER = 'owner-role';

describe('deleting a role', () => {
  const gate = (approvers: string[], minDistinct = 1) => ({
    stage: 'TEST' as const,
    mode: 'approval' as const,
    approver_role_ids: approvers,
    min_distinct_roles: minDistinct,
  });

  it('is blocked when the role is the only approver of an approval gate', () => {
    const error = checkDeleteRole({
      roleId: QA,
      systemKind: null,
      gates: [gate([QA])],
      soleHolders: 0,
    });
    expect(error).toMatchObject({ status: 422, code: 'GATE_UNSTAFFED' });
    expect(error?.detail).toContain('TEST');
  });

  it('is blocked when the gate would not have enough distinct roles left', () => {
    expect(unstaffedGates(QA, [gate([QA, 'lead'], 2)])).toEqual(['TEST']);
    expect(unstaffedGates(QA, [gate([QA, 'lead'], 1)])).toEqual([]);
    expect(unstaffedGates(QA, [{ ...gate([QA]), mode: 'skip' }])).toEqual([]);
  });

  it('never deletes a built-in role or leaves a teammate without a role', () => {
    expect(
      checkDeleteRole({ roleId: OWNER, systemKind: 'owner', gates: [], soleHolders: 0 }),
    ).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(
      checkDeleteRole({ roleId: QA, systemKind: null, gates: [], soleHolders: 2 }),
    ).toMatchObject({ status: 409, detail: expect.stringContaining('2 teammates') });
    expect(checkDeleteRole({ roleId: QA, systemKind: null, gates: [], soleHolders: 0 })).toBeNull();
  });
});

describe("setting a teammate's roles", () => {
  const facts = (current: string[], next: string[], ownerCount: number) => ({
    ownerRoleId: OWNER,
    current: new Set(current),
    next: new Set(next),
    ownerCount,
  });

  it('never removes the last Owner', () => {
    expect(checkMemberRoles(facts([OWNER], [QA], 1))).toMatchObject({
      status: 409,
      code: 'LAST_OWNER',
    });
    expect(checkMemberRoles(facts([OWNER], [QA], 2))).toBeNull();
    expect(checkMemberRoles(facts([QA], [OWNER, QA], 1))).toBeNull();
  });

  it('keeps at least one role', () => {
    expect(checkMemberRoles(facts([QA], [], 1))).toMatchObject({ status: 422 });
  });
});

describe('granting capabilities', () => {
  it('only grants what the caller holds', () => {
    const mine = new Set(['role.manage', 'arena.read']);
    expect(ungrantable(mine, ['arena.read', 'task.verify', 'task.verify'])).toEqual([
      'task.verify',
    ]);
    expect(grantError(['task.verify'])).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(grantError([])).toBeNull();
  });

  it('lets built-in roles change name only', () => {
    expect(checkRoleEdit({ systemKind: 'owner', current: ['a', 'b'], next: ['a'] })).toMatchObject({
      status: 422,
    });
    expect(checkRoleEdit({ systemKind: 'observer', current: ['a'], next: ['a'] })).toBeNull();
    expect(checkRoleEdit({ systemKind: null, current: ['a'], next: [] })).toBeNull();
  });
});

describe('role keys', () => {
  it('slugs the name and avoids taken keys', () => {
    expect(roleKey('QA Engineer', new Set())).toBe('qa_engineer');
    expect(roleKey('QA Engineer', new Set(['qa_engineer']))).toBe('qa_engineer_2');
    expect(roleKey('42', new Set())).toBe('role_42');
    expect(roleKey('!!', new Set())).toBe('role');
  });
});

describe('applying a template', () => {
  let n = 0;
  const id = () => `new-${++n}`;

  it('maps the owner onto the arena Owner and skips keys that exist', () => {
    const template = findRoleTemplate('fe_be_split')!;
    const plan = planTemplate(
      template,
      [
        { id: OWNER, key: 'owner', system_kind: 'owner' },
        { id: 'fe', key: 'frontend_dev', system_kind: null },
      ],
      id,
    );
    expect(plan.ids.get('lead')).toBe(OWNER);
    expect(plan.ids.get('frontend_dev')).toBe('fe');
    expect(plan.create.map((r) => r.key)).toEqual(['backend_dev', 'designer']);
    expect(plan.create.every((r) => r.system_kind === null)).toBe(true);
  });

  it('creates one Observer, and reuses it the next time', () => {
    const template = findRoleTemplate('program')!;
    const first = planTemplate(template, [{ id: OWNER, key: 'owner', system_kind: 'owner' }], id);
    const observer = first.create.find((r) => r.system_kind === 'observer');
    expect(observer?.key).toBe('stakeholder');
    const again = planTemplate(
      template,
      [
        { id: OWNER, key: 'owner', system_kind: 'owner' },
        { id: 'obs', key: 'viewer', system_kind: 'observer' },
      ],
      id,
    );
    expect(again.ids.get('stakeholder')).toBe('obs');
    expect(again.create.some((r) => r.system_kind === 'observer')).toBe(false);
  });

  it('creates nothing for Blank', () => {
    const plan = planTemplate(findRoleTemplate('blank')!, [
      { id: OWNER, key: 'owner', system_kind: 'owner' },
    ]);
    expect(plan.create).toEqual([]);
  });
});
