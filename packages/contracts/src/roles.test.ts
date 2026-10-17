import { describe, expect, it } from 'vitest';
import file from '../../../docs/contracts/role_templates_v2.json' with { type: 'json' };
import { findRoleTemplate, ROLE_TEMPLATES } from './role-templates.js';
import {
  CAPABILITIES,
  CAPABILITY_GROUPS,
  CreateRoleSchema,
  groupCapabilities,
  RoleTemplateFileSchema,
  SetMemberRolesSchema,
  UpdateRoleSchema,
} from './roles.js';

describe('role templates', () => {
  it('parses all seven templates from the contract file', () => {
    expect(ROLE_TEMPLATES.map((t) => t.key)).toEqual([
      'enterprise_squad',
      'platform',
      'program',
      'fe_be_split',
      'lean_squad',
      'research',
      'blank',
    ]);
    expect(findRoleTemplate('lean_squad')?.roles.map((r) => r.key)).toEqual(['owner', 'builder']);
    expect(findRoleTemplate('nope')).toBeUndefined();
  });

  it('uses the same 27 capabilities as the catalogue', () => {
    expect(file.capabilities).toEqual(CAPABILITIES.map((c) => c.key));
  });

  it('rejects an unknown capability, a missing owner and an unknown approver role', () => {
    const bad = structuredClone(file);
    const t = bad.templates[0]!;
    t.roles[1]!.capabilities.push('arena.delete_everything');
    t.roles[0]!.system_kind = null;
    t.gates[0]!.approver_roles = ['ghost'];
    const result = RoleTemplateFileSchema.safeParse(bad);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((i) => i.message).join(' | ');
    expect(messages).toContain('Unknown capability');
    expect(messages).toContain('needs exactly one owner role');
    expect(messages).toContain('unknown role ghost');
  });
});

describe('capability catalogue', () => {
  it('groups the 27 capabilities as doc 03 §3.4 does', () => {
    const groups = groupCapabilities();
    expect(groups.map((g) => g.group)).toEqual([...CAPABILITY_GROUPS]);
    expect(groups.flatMap((g) => g.items)).toHaveLength(27);
    expect(groups.find((g) => g.group === 'Loop')?.items.map((c) => c.key)).toEqual([
      'stage.request_gate',
      'stage.approve.PLAN',
      'stage.approve.DESIGN',
      'stage.approve.BUILD',
      'stage.approve.TEST',
      'stage.approve.DEPLOY',
      'cycle.open',
    ]);
    expect(groups.find((g) => g.group === 'People')?.items.every((c) => c.risk === 'high')).toBe(
      true,
    );
  });
});

describe('role inputs', () => {
  it('dedupes and sorts capabilities, and rejects unknown ones', () => {
    expect(
      CreateRoleSchema.parse({
        name: ' QA ',
        capabilities: ['task.verify', 'arena.read', 'arena.read'],
      }),
    ).toEqual({ name: 'QA', capabilities: ['arena.read', 'task.verify'] });
    expect(CreateRoleSchema.safeParse({ name: 'X', capabilities: ['root'] }).success).toBe(false);
    expect(CreateRoleSchema.safeParse({ name: 'X', capabilities: [], color: 'ai' }).success).toBe(
      false,
    );
  });

  it('needs something to change and at least one member role', () => {
    expect(UpdateRoleSchema.safeParse({}).success).toBe(false);
    expect(SetMemberRolesSchema.safeParse({ role_ids: [] }).success).toBe(false);
    const id = '0191d1a2-0000-7000-8000-00000000000A';
    expect(SetMemberRolesSchema.parse({ role_ids: [id, id.toLowerCase()] }).role_ids).toEqual([
      id.toLowerCase(),
    ]);
  });
});
