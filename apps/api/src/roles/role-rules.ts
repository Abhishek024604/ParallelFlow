import type { SdlcStage } from '@parallelflow/contracts';

// Pure rules for roles (build step 8), kept apart from SQL so they are unit-tested. The handlers in
// roles.ts load the facts in one query and apply these before writing.

export type RuleError =
  | { status: 403; code: 'FORBIDDEN'; detail: string; missing: string[] }
  | { status: 409; code: 'CONFLICT' | 'LAST_OWNER'; detail: string }
  | { status: 422; code: 'GATE_UNSTAFFED' | 'PRECONDITION_FAILED'; detail: string };

/** Capabilities in `wanted` the caller does not hold: you can only grant what you have. */
export function ungrantable(callerCaps: ReadonlySet<string>, wanted: Iterable<string>): string[] {
  return [...new Set(wanted)].filter((c) => !callerCaps.has(c)).sort();
}

export function grantError(missing: string[]): RuleError | null {
  if (missing.length === 0) return null;
  return {
    status: 403,
    code: 'FORBIDDEN',
    detail: `You can only grant what you can do yourself (${missing.join(', ')}).`,
    missing,
  };
}

export interface GateUse {
  stage: SdlcStage;
  mode: 'approval' | 'auto' | 'skip';
  approver_role_ids: string[];
  min_distinct_roles: number;
}

export interface DeleteFacts {
  roleId: string;
  systemKind: 'owner' | 'observer' | null;
  gates: GateUse[];
  /** Teammates for whom this is the only role. */
  soleHolders: number;
}

/** Stages whose approval gate would be left without enough approver roles. */
export function unstaffedGates(roleId: string, gates: readonly GateUse[]): SdlcStage[] {
  return gates
    .filter((g) => g.mode === 'approval' && g.approver_role_ids.includes(roleId))
    .filter((g) => g.approver_role_ids.length - 1 < Math.max(1, g.min_distinct_roles))
    .map((g) => g.stage);
}

export function checkDeleteRole(facts: DeleteFacts): RuleError | null {
  if (facts.systemKind) {
    return { status: 409, code: 'CONFLICT', detail: 'Built-in roles cannot be deleted.' };
  }
  const stages = unstaffedGates(facts.roleId, facts.gates);
  if (stages.length > 0) {
    return {
      status: 422,
      code: 'GATE_UNSTAFFED',
      detail: `This role approves ${stages.join(', ')}. Add another approver role to that gate first.`,
    };
  }
  if (facts.soleHolders > 0) {
    const who = facts.soleHolders === 1 ? '1 teammate has' : `${facts.soleHolders} teammates have`;
    return {
      status: 409,
      code: 'CONFLICT',
      detail: `${who} only this role. Give them another role first.`,
    };
  }
  return null;
}

export interface MemberRoleFacts {
  ownerRoleId: string;
  current: ReadonlySet<string>;
  next: ReadonlySet<string>;
  /** Teammates holding the Owner role now (locked by the caller). */
  ownerCount: number;
}

export function checkMemberRoles(facts: MemberRoleFacts): RuleError | null {
  if (facts.next.size === 0) {
    return {
      status: 422,
      code: 'PRECONDITION_FAILED',
      detail: 'A teammate needs at least one role.',
    };
  }
  const losesOwner = facts.current.has(facts.ownerRoleId) && !facts.next.has(facts.ownerRoleId);
  if (losesOwner && facts.ownerCount <= 1) {
    return {
      status: 409,
      code: 'LAST_OWNER',
      detail: 'Every arena needs an Owner. Make someone else Owner first.',
    };
  }
  return null;
}

export interface RoleEditFacts {
  systemKind: 'owner' | 'observer' | null;
  current: readonly string[];
  next: readonly string[] | undefined;
}

/** System roles keep their capabilities (name and colour only). */
export function checkRoleEdit(facts: RoleEditFacts): RuleError | null {
  if (!facts.systemKind || facts.next === undefined) return null;
  const same =
    facts.next.length === facts.current.length &&
    facts.next.every((c) => facts.current.includes(c));
  if (same) return null;
  return {
    status: 422,
    code: 'PRECONDITION_FAILED',
    detail:
      facts.systemKind === 'owner'
        ? 'The Owner can always do everything.'
        : 'Built-in roles can be renamed only.',
  };
}

/** A unique role key from a name: `qa_engineer`, then `qa_engineer_2`, … */
export function roleKey(name: string, taken: ReadonlySet<string>): string {
  let base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 34);
  if (!/^[a-z]/.test(base)) base = `role_${base}`.slice(0, 34);
  if (base.length < 2) base = 'role';
  base = base.replace(/_+$/, '');
  if (!taken.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const key = `${base}_${i}`;
    if (!taken.has(key)) return key;
  }
}
