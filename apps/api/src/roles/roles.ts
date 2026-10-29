import {
  CAPABILITIES,
  type ApplyTemplate,
  defaultRoleStages,
  type CreateRole,
  type ProjectMember,
  ROLE_COLORS,
  type Role,
  type RoleList,
  type RoleTemplate,
  type SdlcStage,
  type SetMemberRoles,
  type UpdateRole,
  uuidv7,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { initials } from '../arenas/naming.js';
import { ApiError, notFound, validationFailed } from '../pipeline/errors.js';
import {
  checkDeleteRole,
  checkMemberRoles,
  checkRoleEdit,
  type GateUse,
  grantError,
  type RuleError,
  roleKey,
  ungrantable,
} from './role-rules.js';

// Custom roles (build step 8). Every function runs in the pipeline's verified tenant transaction
// (@ProjectScoped): a write is one locking read of the facts, the rules (role-rules.ts), then one or
// two write statements. The pipeline drops this project's cached reads once the write commits.
//
// Permission: every write needs `role.manage`, and you can only grant capabilities you hold yourself
// (through a role's capabilities, by giving someone a role, or by applying a template). The Owner
// holds every capability, so only an Owner can make someone Owner. Mapping a template's gates also
// needs `project.settings` (gate policies are project settings, doc 03 §3.4).

export const ROLE_MANAGE = 'role.manage';
const PROJECT_SETTINGS = 'project.settings';
const ALL_CAPS = CAPABILITIES.map((c) => c.key).sort();

export interface RoleScope {
  projectId: string;
  orgId: string;
  userId: string;
}

function fail(error: RuleError): never {
  throw new ApiError(error.status, error.code, {
    detail: error.detail,
    ...(error.status === 403 && { requiredPermission: `cap ${error.missing.join(', ')}` }),
  });
}

function requireCap(caps: ReadonlySet<string>, capability: string): void {
  if (caps.has(capability)) return;
  throw new ApiError(403, 'FORBIDDEN', {
    detail:
      capability === ROLE_MANAGE
        ? 'You cannot change roles in this arena.'
        : 'You cannot change stage gates in this arena.',
    requiredPermission: `cap ${capability}`,
  });
}

/** The caller's effective capabilities in the project (SQL fragment, text[]). */
const callerCaps = (s: RoleScope) => sql<string[]>`
  COALESCE((SELECT array_agg(mc.capability) FROM member_capabilities mc
             WHERE mc.project_id = ${s.projectId} AND mc.user_id = ${s.userId}), '{}')`;

interface RoleRow {
  id: string;
  key: string;
  name: string;
  system_kind: Role['system_kind'];
  color: string | null;
  template_key: string | null;
  capabilities: string[] | null;
  member_count: number;
  approves: SdlcStage[] | null;
  stages: SdlcStage[] | null;
}

const toRole = (row: RoleRow): Role => ({
  id: row.id,
  key: row.key,
  name: row.name,
  system_kind: row.system_kind,
  color: row.color,
  template_key: row.template_key,
  capabilities: row.system_kind === 'owner' ? ALL_CAPS : [...(row.capabilities ?? [])].sort(),
  member_count: row.member_count,
  approves: row.approves ?? [],
  stages: row.stages ?? [],
});

/** Roles of the project with capabilities, member counts and the gates they approve. One query. */
async function selectRoles(tx: Tx, projectId: string, roleId?: string): Promise<Role[]> {
  const { rows } = await sql<RoleRow>`
    SELECT r.id, r.key, r.name, r.system_kind, r.color, r.template_key, r.stages::text[] AS stages,
           (SELECT array_agg(rc.capability) FROM role_capabilities rc WHERE rc.role_id = r.id)
             AS capabilities,
           (SELECT count(*)::int FROM project_member_roles pmr WHERE pmr.role_id = r.id)
             AS member_count,
           (SELECT array_agg(g.stage::text ORDER BY g.stage) FROM stage_gate_policies g
             WHERE g.project_id = r.project_id AND g.mode = 'approval'
               AND r.id = ANY(g.approver_role_ids)) AS approves
      FROM project_roles r
     WHERE r.project_id = ${projectId} ${roleId ? sql`AND r.id = ${roleId}` : sql``}
     ORDER BY CASE r.system_kind WHEN 'owner' THEN 0 WHEN 'observer' THEN 2 ELSE 1 END,
              r.created_at, r.id`.execute(tx);
  return rows.map(toRole);
}

/** GET /projects/{project_id}/roles (cap arena.read: every member). */
export async function listRoles(tx: Tx, s: RoleScope): Promise<RoleList> {
  const [items, caps] = await Promise.all([
    selectRoles(tx, s.projectId),
    sql<{ caps: string[] }>`SELECT ${callerCaps(s)} AS caps`.execute(tx),
  ]);
  const canManage = (caps.rows[0]?.caps ?? []).includes(ROLE_MANAGE);
  return { items, viewer: { user_id: s.userId, can_manage: canManage } };
}

/** POST /projects/{project_id}/roles. */
export async function createRole(tx: Tx, s: RoleScope, input: CreateRole): Promise<Role> {
  const { rows } = await sql<{ caps: string[]; keys: string[] | null }>`
    SELECT ${callerCaps(s)} AS caps,
           (SELECT array_agg(key) FROM project_roles WHERE project_id = ${s.projectId}) AS keys`.execute(
    tx,
  );
  const caps = new Set(rows[0]?.caps ?? []);
  const keys = new Set(rows[0]?.keys ?? []);
  requireCap(caps, ROLE_MANAGE);
  const denied = grantError(ungrantable(caps, input.capabilities));
  if (denied) fail(denied);
  if (input.key && keys.has(input.key)) {
    throw new ApiError(409, 'ALREADY_EXISTS', { detail: 'A role with this key already exists.' });
  }
  const id = uuidv7();
  const key = input.key ?? roleKey(input.name, keys);
  const color = input.color ?? ROLE_COLORS[keys.size % ROLE_COLORS.length] ?? 'acc';
  const stages = input.stages ?? defaultRoleStages(input.name);
  await sql`
    WITH r AS (
      INSERT INTO project_roles (id, org_id, project_id, key, name, color, stages)
      VALUES (${id}, ${s.orgId}, ${s.projectId}, ${key}, ${input.name}, ${color},
              ${stages}::sdlc_stage[]) RETURNING id
    )
    INSERT INTO role_capabilities (org_id, role_id, capability)
    SELECT ${s.orgId}, r.id, c FROM r, unnest(${input.capabilities}::text[]) AS c`.execute(tx);
  return {
    id,
    key,
    name: input.name,
    system_kind: null,
    color,
    template_key: null,
    capabilities: input.capabilities,
    member_count: 0,
    approves: [],
    stages,
  };
}

/** PATCH /projects/{project_id}/roles/{role_id}. */
export async function updateRole(
  tx: Tx,
  s: RoleScope,
  roleId: string,
  patch: UpdateRole,
): Promise<Role> {
  const { rows } = await sql<{
    role: { system_kind: Role['system_kind'] } | null;
    role_caps: string[];
    caps: string[];
  }>`
    WITH r AS (SELECT id, system_kind FROM project_roles
                WHERE id = ${roleId} AND project_id = ${s.projectId} FOR UPDATE)
    SELECT (SELECT row_to_json(r) FROM r) AS role,
           COALESCE((SELECT array_agg(rc.capability) FROM role_capabilities rc
                      WHERE rc.role_id = ${roleId}), '{}') AS role_caps,
           ${callerCaps(s)} AS caps`.execute(tx);
  const row = rows[0];
  if (!row?.role) throw notFound();
  const caps = new Set(row.caps);
  requireCap(caps, ROLE_MANAGE);
  const kind = row.role.system_kind;
  const current = kind === 'owner' ? ALL_CAPS : row.role_caps;
  const edit = checkRoleEdit({ systemKind: kind, current, next: patch.capabilities });
  if (edit) fail(edit);
  const replace = !kind && patch.capabilities !== undefined;
  const next = patch.capabilities ?? [];
  if (replace) {
    const added = next.filter((c) => !current.includes(c));
    const denied = grantError(ungrantable(caps, added));
    if (denied) fail(denied);
  }
  await sql`
    WITH u AS (
      UPDATE project_roles
         SET name = COALESCE(${patch.name ?? null}, name), color = COALESCE(${patch.color ?? null}, color),
             stages = COALESCE(${patch.stages ?? null}::sdlc_stage[], stages)
       WHERE id = ${roleId} RETURNING id
    ),
    d AS (
      DELETE FROM role_capabilities
       WHERE ${replace} AND role_id = ${roleId} AND NOT (capability = ANY(${next}::text[]))
      RETURNING 1
    )
    INSERT INTO role_capabilities (org_id, role_id, capability)
    SELECT ${s.orgId}, ${roleId}, c FROM unnest(${next}::text[]) AS c WHERE ${replace}
    ON CONFLICT DO NOTHING`.execute(tx);
  const [role] = await selectRoles(tx, s.projectId, roleId);
  if (!role) throw notFound();
  return role;
}

/** DELETE /projects/{project_id}/roles/{role_id}: never leaves a gate or a teammate without a role. */
export async function deleteRole(tx: Tx, s: RoleScope, roleId: string): Promise<void> {
  const { rows } = await sql<{
    role: { system_kind: Role['system_kind'] } | null;
    gates: GateUse[];
    sole_holders: number;
    caps: string[];
  }>`
    WITH r AS (SELECT id, system_kind FROM project_roles
                WHERE id = ${roleId} AND project_id = ${s.projectId} FOR UPDATE),
         g AS (SELECT stage, mode, approver_role_ids, min_distinct_roles FROM stage_gate_policies
                WHERE project_id = ${s.projectId} AND ${roleId} = ANY(approver_role_ids) FOR UPDATE)
    SELECT (SELECT row_to_json(r) FROM r) AS role,
           COALESCE((SELECT json_agg(g) FROM g), '[]'::json) AS gates,
           (SELECT count(*)::int FROM project_member_roles pmr
             WHERE pmr.role_id = ${roleId}
               AND NOT EXISTS (SELECT 1 FROM project_member_roles o
                                WHERE o.project_id = pmr.project_id AND o.user_id = pmr.user_id
                                  AND o.role_id <> pmr.role_id)) AS sole_holders,
           ${callerCaps(s)} AS caps`.execute(tx);
  const row = rows[0];
  if (!row?.role) throw notFound();
  requireCap(new Set(row.caps), ROLE_MANAGE);
  const blocked = checkDeleteRole({
    roleId,
    systemKind: row.role.system_kind,
    gates: row.gates,
    soleHolders: row.sole_holders,
  });
  if (blocked) fail(blocked);
  // References without ON DELETE first (gates keep their other approvers; tasks and requests lose
  // the role), then the role itself; role_capabilities and member assignments cascade.
  await sql`
    WITH g AS (
      UPDATE stage_gate_policies
         SET approver_role_ids = array_remove(approver_role_ids, ${roleId}::uuid),
             notify_role_ids = array_remove(notify_role_ids, ${roleId}::uuid), updated_at = now()
       WHERE project_id = ${s.projectId}
         AND (${roleId} = ANY(approver_role_ids) OR ${roleId} = ANY(notify_role_ids))
      RETURNING 1
    ),
    t AS (UPDATE tasks SET assignee_role_id = NULL
           WHERE project_id = ${s.projectId} AND assignee_role_id = ${roleId} RETURNING 1)
    UPDATE access_requests SET requested_role_id = NULL WHERE requested_role_id = ${roleId}`.execute(
    tx,
  );
  await sql`DELETE FROM project_roles WHERE id = ${roleId}`.execute(tx);
}

interface MemberFacts {
  owner_role_id: string | null;
  owner_count: number;
  member: { display_name: string; email: string; added_at: string } | null;
  current: string[];
  roles: { id: string; name: string; system_kind: Role['system_kind']; caps: string[] | null }[];
  caps: string[];
}

/** PATCH /projects/{project_id}/members/{user_id}: replaces the member's roles. */
export async function setMemberRoles(
  tx: Tx,
  s: RoleScope,
  userId: string,
  input: SetMemberRoles,
): Promise<ProjectMember> {
  const ids = input.role_ids;
  // The Owner assignments are locked, so two teammates cannot both step down as the last Owner.
  const { rows } = await sql<MemberFacts>`
    WITH owners AS (
      SELECT pmr.user_id FROM project_member_roles pmr
        JOIN project_roles r ON r.id = pmr.role_id AND r.system_kind = 'owner'
       WHERE pmr.project_id = ${s.projectId} FOR UPDATE OF pmr
    )
    SELECT (SELECT id FROM project_roles
             WHERE project_id = ${s.projectId} AND system_kind = 'owner') AS owner_role_id,
           (SELECT count(*)::int FROM owners) AS owner_count,
           (SELECT json_build_object('display_name', u.display_name, 'email', u.email,
                                     'added_at', pm.added_at)
              FROM project_members pm JOIN users u ON u.id = pm.user_id
             WHERE pm.project_id = ${s.projectId} AND pm.user_id = ${userId}) AS member,
           COALESCE((SELECT array_agg(role_id::text) FROM project_member_roles
                      WHERE project_id = ${s.projectId} AND user_id = ${userId}), '{}') AS current,
           COALESCE((SELECT json_agg(json_build_object(
                       'id', r.id, 'name', r.name, 'system_kind', r.system_kind,
                       'caps', (SELECT array_agg(rc.capability) FROM role_capabilities rc
                                 WHERE rc.role_id = r.id)))
                       FROM project_roles r
                      WHERE r.project_id = ${s.projectId} AND r.id = ANY(${ids}::uuid[])),
                    '[]'::json) AS roles,
           ${callerCaps(s)} AS caps`.execute(tx);
  const row = rows[0];
  if (!row?.member || !row.owner_role_id) throw notFound();
  const caps = new Set(row.caps);
  requireCap(caps, ROLE_MANAGE);
  if (row.roles.length !== ids.length) {
    throw validationFailed([{ field: 'role_ids', message: 'Unknown role' }]);
  }
  const current = new Set(row.current);
  const ruled = checkMemberRoles({
    ownerRoleId: row.owner_role_id,
    current,
    next: new Set(ids),
    ownerCount: row.owner_count,
  });
  if (ruled) fail(ruled);
  const added = row.roles.filter((r) => !current.has(r.id));
  const granted = added.flatMap((r) => (r.system_kind === 'owner' ? ALL_CAPS : (r.caps ?? [])));
  const denied = grantError(ungrantable(caps, granted));
  if (denied) fail(denied);
  await sql`
    WITH d AS (
      DELETE FROM project_member_roles
       WHERE project_id = ${s.projectId} AND user_id = ${userId}
         AND NOT (role_id = ANY(${ids}::uuid[]))
      RETURNING 1
    )
    INSERT INTO project_member_roles (org_id, project_id, user_id, role_id)
    SELECT ${s.orgId}, ${s.projectId}, ${userId}, id FROM unnest(${ids}::uuid[]) AS id
    ON CONFLICT DO NOTHING`.execute(tx);
  const roles = [...row.roles].sort(
    (a, b) =>
      Number(b.system_kind === 'owner') - Number(a.system_kind === 'owner') ||
      a.name.localeCompare(b.name),
  );
  return {
    user_id: userId,
    display_name: row.member.display_name,
    initials: initials(row.member.display_name),
    email: row.member.email,
    roles: roles.map((r) => ({ id: r.id, name: r.name })),
    is_owner: ids.includes(row.owner_role_id),
    added_at: new Date(row.member.added_at).toISOString(),
  };
}

export interface TemplatePlan {
  /** Roles to create (custom ones whose key is free; an Observer if the arena has none). */
  create: {
    id: string;
    key: string;
    name: string;
    system_kind: 'observer' | null;
    color: string;
    capabilities: string[];
    stages: SdlcStage[];
  }[];
  /** Template role key → the arena role id it maps to. */
  ids: Map<string, string>;
}

/** Which template roles to create and how template keys map onto the arena's roles. Pure. */
export function planTemplate(
  template: RoleTemplate,
  existing: readonly { id: string; key: string; system_kind: Role['system_kind'] }[],
  newId: () => string = uuidv7,
): TemplatePlan {
  const byKey = new Map(existing.map((r) => [r.key, r.id]));
  const owner = existing.find((r) => r.system_kind === 'owner');
  const observer = existing.find((r) => r.system_kind === 'observer');
  const ids = new Map<string, string>();
  const create: TemplatePlan['create'] = [];
  let n = existing.length;
  for (const role of template.roles) {
    const found =
      role.system_kind === 'owner'
        ? owner?.id
        : role.system_kind === 'observer'
          ? (observer?.id ?? byKey.get(role.key))
          : byKey.get(role.key);
    if (found) {
      ids.set(role.key, found);
      continue;
    }
    if (role.system_kind === 'owner') continue; // every arena has its Owner; never a second one
    const id = newId();
    ids.set(role.key, id);
    byKey.set(role.key, id);
    create.push({
      id,
      key: role.key,
      name: role.name,
      system_kind: role.system_kind,
      color: ROLE_COLORS[n % ROLE_COLORS.length] ?? 'acc',
      capabilities: [...new Set(role.capabilities)].sort(),
      stages: role.system_kind ? [] : defaultRoleStages(role.key),
    });
    n += 1;
  }
  return { create, ids };
}

/** POST /projects/{project_id}/roles:apply-template. Adds roles; never deletes or renames one. */
export async function applyTemplate(
  tx: Tx,
  s: RoleScope,
  template: RoleTemplate,
  input: ApplyTemplate,
): Promise<RoleList> {
  const { rows } = await sql<{
    caps: string[];
    roles: { id: string; key: string; system_kind: Role['system_kind'] }[];
  }>`
    SELECT ${callerCaps(s)} AS caps,
           COALESCE((SELECT json_agg(json_build_object('id', id, 'key', key,
                                                        'system_kind', system_kind))
                       FROM project_roles WHERE project_id = ${s.projectId}), '[]'::json) AS roles`.execute(
    tx,
  );
  const caps = new Set(rows[0]?.caps ?? []);
  requireCap(caps, ROLE_MANAGE);
  if (input.gates) requireCap(caps, PROJECT_SETTINGS);
  const plan = planTemplate(template, rows[0]?.roles ?? []);
  const denied = grantError(
    ungrantable(
      caps,
      plan.create.flatMap((r) => r.capabilities),
    ),
  );
  if (denied) fail(denied);

  if (plan.create.length > 0) {
    const roleRows = plan.create.map(({ capabilities: _caps, ...r }) => r);
    const capRows = plan.create.flatMap((r) =>
      r.capabilities.map((capability) => ({ role_id: r.id, capability })),
    );
    await sql`
      WITH r AS (
        INSERT INTO project_roles (id, org_id, project_id, key, name, system_kind, color, template_key,
                                   stages)
        SELECT x.id, ${s.orgId}, ${s.projectId}, x.key, x.name, x.system_kind, x.color, ${template.key},
               ARRAY(SELECT jsonb_array_elements_text(x.stages))::sdlc_stage[]
          FROM jsonb_to_recordset(${JSON.stringify(roleRows)}::jsonb)
               AS x(id uuid, key text, name text, system_kind text, color text, stages jsonb)
        RETURNING id
      )
      INSERT INTO role_capabilities (org_id, role_id, capability)
      SELECT ${s.orgId}, c.role_id, c.capability
        FROM jsonb_to_recordset(${JSON.stringify(capRows)}::jsonb) AS c(role_id uuid, capability text)`.execute(
      tx,
    );
  }

  // Approval gates only: the loop does not run `skip` / `auto` gates yet (SLICE_DEBT), so those keep
  // their current setting.
  const gates = input.gates
    ? template.gates
        .filter((g) => g.mode === 'approval')
        .map((g) => ({
          stage: g.stage,
          approvers: g.approver_roles.flatMap((k) => plan.ids.get(k) ?? []),
          min_approvals: g.min_approvals,
          min_distinct_roles: g.min_distinct_roles,
          forbid_self_approval: g.forbid_self_approval,
        }))
        .filter((g) => g.approvers.length >= g.min_distinct_roles)
    : [];
  if (gates.length > 0) {
    await sql`
      UPDATE stage_gate_policies g
         SET mode = 'approval',
             approver_role_ids = ARRAY(SELECT jsonb_array_elements_text(x.approvers)::uuid),
             min_approvals = x.min_approvals, min_distinct_roles = x.min_distinct_roles,
             forbid_self_approval = x.forbid_self_approval, updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(gates)}::jsonb)
             AS x(stage text, approvers jsonb, min_approvals int, min_distinct_roles int,
                  forbid_self_approval boolean)
       WHERE g.project_id = ${s.projectId} AND g.stage = x.stage::sdlc_stage`.execute(tx);
  }
  return {
    items: await selectRoles(tx, s.projectId),
    viewer: { user_id: s.userId, can_manage: true },
  };
}
