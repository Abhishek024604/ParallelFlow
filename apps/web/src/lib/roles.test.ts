import type { ProjectMember, Role } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { roleDot, toggleRole, withMemberRoles } from './roles';

const role = (id: string, name: string, extra: Partial<Role> = {}): Role => ({
  id,
  key: id,
  name,
  system_kind: null,
  color: null,
  template_key: null,
  capabilities: [],
  member_count: 0,
  approves: [],
  ...extra,
});

const owner = role('o', 'Owner', { system_kind: 'owner', member_count: 1 });
const qa = role('q', 'QA');
const riya: ProjectMember = {
  user_id: 'u1',
  display_name: 'Riya',
  initials: 'R',
  email: 'r@x.test',
  roles: [{ id: 'o', name: 'Owner' }],
  is_owner: true,
  added_at: '2026-10-01T00:00:00.000Z',
};

describe('roles page helpers', () => {
  it('toggles a role chip', () => {
    expect(toggleRole(riya, 'q')).toEqual(['o', 'q']);
    expect(toggleRole(riya, 'o')).toEqual([]);
  });

  it('updates the member and the role counts optimistically', () => {
    const next = withMemberRoles([riya], [owner, qa], 'u1', ['q']);
    expect(next.members[0]).toMatchObject({ roles: [{ id: 'q', name: 'QA' }], is_owner: false });
    expect(next.roles.map((r) => r.member_count)).toEqual([0, 1]);
  });

  it('maps colours to tokens only', () => {
    expect(roleDot('ok')).toBe('bg-ok');
    expect(roleDot('#ff0000')).toBe('bg-sand');
    expect(roleDot(null)).toBe('bg-sand');
  });
});
