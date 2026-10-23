import type { ProjectMember, Role } from '@parallelflow/contracts';

// Client-side helpers for the Roles settings page (build step 8): colour tokens and the optimistic
// view of a role change, replaced by the server's answer (or rolled back on an error).

/** Role colour (a brand token name) → its Tailwind class. Unknown or missing → sand. */
const DOT: Record<string, string> = {
  acc: 'bg-acc',
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  sage: 'bg-sage',
  ink: 'bg-ink',
  sand: 'bg-sand',
};
export const roleDot = (color: string | null): string => DOT[color ?? ''] ?? 'bg-sand';

/** Plain copy for the `LAST_OWNER` / `GATE_UNSTAFFED` / `FORBIDDEN` answers. */
export function roleErrorText(code: string, detail: string): string {
  switch (code) {
    case 'LAST_OWNER':
      return 'Every arena needs an Owner. Make someone else Owner first.';
    case 'GATE_UNSTAFFED':
      return detail || 'This role is the only approver of a stage gate.';
    default:
      return detail;
  }
}

/** A member's role ids with `roleId` toggled on or off. */
export function toggleRole(member: ProjectMember, roleId: string): string[] {
  const ids = member.roles.map((r) => r.id);
  return ids.includes(roleId) ? ids.filter((id) => id !== roleId) : [...ids, roleId];
}

/** The member and role counts as they will be once `roleIds` is saved for `userId`. */
export function withMemberRoles(
  members: readonly ProjectMember[],
  roles: readonly Role[],
  userId: string,
  roleIds: readonly string[],
): { members: ProjectMember[]; roles: Role[] } {
  const member = members.find((m) => m.user_id === userId);
  if (!member) return { members: [...members], roles: [...roles] };
  const before = new Set(member.roles.map((r) => r.id));
  const after = new Set(roleIds);
  const owner = roles.find((r) => r.system_kind === 'owner');
  const next: ProjectMember = {
    ...member,
    roles: roles.filter((r) => after.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
    is_owner: owner ? after.has(owner.id) : member.is_owner,
  };
  return {
    members: members.map((m) => (m.user_id === userId ? next : m)),
    roles: roles.map((r) => {
      const delta = Number(after.has(r.id)) - Number(before.has(r.id));
      return delta === 0 ? r : { ...r, member_count: Math.max(0, r.member_count + delta) };
    }),
  };
}
