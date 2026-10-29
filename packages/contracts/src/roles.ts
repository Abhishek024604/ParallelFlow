import { z } from 'zod';
import { SDLC_STAGES, type SdlcStage } from './arenas.js';

// Custom roles (build step 8): the capability catalogue as doc 03 §3.4 groups it, role shapes and
// inputs (openapi_v2.yaml Role, RoleInput, Capability, RoleTemplate) and the template schema. The
// template data itself is loaded by `@parallelflow/contracts/role-templates` (server only).

export type CapabilityRisk = 'low' | 'medium' | 'high';

export interface Capability {
  key: string;
  group: CapabilityGroup;
  description: string;
  risk: CapabilityRisk;
}

export const CAPABILITY_GROUPS = [
  'Arena',
  'AI',
  'Artifacts',
  'Tasks',
  'Loop',
  'Code',
  'People',
  'Project',
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

/**
 * The 28 capabilities: doc 03 §3.4's 27 in its order, then `pr.merge` (ADR-037). Same keys as the
 * seeded `capabilities` table.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    key: 'arena.read',
    group: 'Arena',
    risk: 'low',
    description: 'Read messages, files and the loop',
  },
  { key: 'arena.post', group: 'Arena', risk: 'low', description: 'Post, reply and tag teammates' },
  { key: 'arena.tag_roles', group: 'Arena', risk: 'low', description: 'Tag a whole role at once' },
  { key: 'agent.invoke', group: 'AI', risk: 'low', description: 'Ask the AI in the arena' },
  { key: 'agent.assign_task', group: 'AI', risk: 'medium', description: 'Give a task to the AI' },
  { key: 'agent.configure', group: 'AI', risk: 'high', description: 'Change what the AI may do' },
  { key: 'routine.manage', group: 'AI', risk: 'medium', description: 'Create and run routines' },
  { key: 'artifact.push', group: 'Artifacts', risk: 'low', description: 'Push files from Private' },
  { key: 'artifact.edit', group: 'Artifacts', risk: 'low', description: 'Save new file versions' },
  { key: 'artifact.export', group: 'Artifacts', risk: 'low', description: 'Download files' },
  { key: 'task.create', group: 'Tasks', risk: 'low', description: 'Create tasks' },
  { key: 'task.assign', group: 'Tasks', risk: 'low', description: 'Assign tasks to teammates' },
  { key: 'task.delegate', group: 'Tasks', risk: 'low', description: 'Hand tasks to a role' },
  { key: 'task.verify', group: 'Tasks', risk: 'medium', description: 'Verify and close tasks' },
  {
    key: 'stage.request_gate',
    group: 'Loop',
    risk: 'low',
    description: 'Ask to move to the next stage',
  },
  { key: 'stage.approve.PLAN', group: 'Loop', risk: 'medium', description: 'Approve leaving PLAN' },
  {
    key: 'stage.approve.DESIGN',
    group: 'Loop',
    risk: 'medium',
    description: 'Approve leaving DESIGN',
  },
  {
    key: 'stage.approve.BUILD',
    group: 'Loop',
    risk: 'medium',
    description: 'Approve leaving BUILD',
  },
  { key: 'stage.approve.TEST', group: 'Loop', risk: 'medium', description: 'Approve leaving TEST' },
  { key: 'stage.approve.DEPLOY', group: 'Loop', risk: 'high', description: 'Approve a release' },
  { key: 'cycle.open', group: 'Loop', risk: 'medium', description: 'Start the next cycle' },
  { key: 'member.invite', group: 'People', risk: 'high', description: 'Invite teammates' },
  { key: 'member.remove', group: 'People', risk: 'high', description: 'Remove teammates' },
  {
    key: 'role.manage',
    group: 'People',
    risk: 'high',
    description: 'Edit roles and who holds them',
  },
  { key: 'access.approve', group: 'People', risk: 'high', description: 'Approve access requests' },
  { key: 'project.settings', group: 'Project', risk: 'high', description: 'Change arena settings' },
  { key: 'project.archive', group: 'Project', risk: 'high', description: 'Archive the arena' },
  {
    key: 'pr.merge',
    group: 'Code',
    risk: 'high',
    description: 'Approve and merge pull requests into main',
  },
];

export const CAPABILITY_KEYS: ReadonlySet<string> = new Set(CAPABILITIES.map((c) => c.key));

/** The catalogue grouped for the checklist, groups in doc 03 order. */
export function groupCapabilities(
  list: readonly Capability[] = CAPABILITIES,
): { group: CapabilityGroup; items: Capability[] }[] {
  return CAPABILITY_GROUPS.map((group) => ({
    group,
    items: list.filter((c) => c.group === group),
  })).filter((g) => g.items.length > 0);
}

/** Role colours: brand token names, never hex. `ai` (dusk) is reserved for the AI. */
export const ROLE_COLORS = ['acc', 'ok', 'warn', 'bad', 'sage', 'ink', 'sand'] as const;
export type RoleColor = (typeof ROLE_COLORS)[number];

export const ROLE_NAME_MAX_CHARS = 60;
export const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export interface Role {
  id: string;
  key: string;
  name: string;
  system_kind: 'owner' | 'observer' | null;
  color: string | null;
  template_key: string | null;
  /** The Owner role lists every capability. */
  capabilities: string[];
  member_count: number;
  /** Stages whose gate this role approves. */
  approves: SdlcStage[];
  /** Stages this role works in (ADR-041): its members get the handoff when the loop enters one. */
  stages: SdlcStage[];
}

export interface RoleList {
  items: Role[];
  viewer: { user_id: string; can_manage: boolean };
}

const CapabilityKey = z.string().refine((k) => CAPABILITY_KEYS.has(k), 'Unknown capability');
const Capabilities = z
  .array(CapabilityKey)
  .max(CAPABILITIES.length * 2)
  .transform((caps) => [...new Set(caps)].sort());
const Stages = z
  .array(z.enum(SDLC_STAGES))
  .max(SDLC_STAGES.length * 2)
  .transform((list) => SDLC_STAGES.filter((s) => list.includes(s)));
const RoleName = z
  .string()
  .trim()
  .min(1, 'Give the role a name')
  .max(ROLE_NAME_MAX_CHARS, `At most ${ROLE_NAME_MAX_CHARS} characters`);

/** POST /projects/{project_id}/roles (RoleInput). */
export const CreateRoleSchema = z
  .object({
    key: z.string().regex(ROLE_KEY_PATTERN, 'Lowercase letters, digits and _').optional(),
    name: RoleName,
    capabilities: Capabilities,
    color: z.enum(ROLE_COLORS).optional(),
    /** Defaults from the role's name (defaultRoleStages). */
    stages: Stages.optional(),
  })
  .strict();
export type CreateRole = z.infer<typeof CreateRoleSchema>;
export type CreateRoleInput = z.input<typeof CreateRoleSchema>;

/** PATCH /projects/{project_id}/roles/{role_id}. System roles: name and colour only. */
export const UpdateRoleSchema = z
  .object({
    name: RoleName.optional(),
    capabilities: Capabilities.optional(),
    color: z.enum(ROLE_COLORS).optional(),
    stages: Stages.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export type UpdateRole = z.infer<typeof UpdateRoleSchema>;
export type UpdateRoleInput = z.input<typeof UpdateRoleSchema>;

/** PATCH /projects/{project_id}/members/{user_id}: a member always keeps at least one role. */
export const SetMemberRolesSchema = z
  .object({
    role_ids: z
      .array(z.string().uuid('Must be a uuid'))
      .min(1, 'A teammate needs at least one role')
      .max(50)
      .transform((ids) => [...new Set(ids.map((id) => id.toLowerCase()))]),
  })
  .strict();
export type SetMemberRoles = z.infer<typeof SetMemberRolesSchema>;

/** POST /projects/{project_id}/roles:apply-template. */
export const ApplyTemplateSchema = z
  .object({
    template_key: z.string().min(1).max(60),
    /** Also map the template's gates (approver roles, counts) onto the arena's stage gates. */
    gates: z.boolean().default(false),
  })
  .strict();
export type ApplyTemplate = z.infer<typeof ApplyTemplateSchema>;
export type ApplyTemplateInput = z.input<typeof ApplyTemplateSchema>;

// ---- templates (docs/contracts/role_templates_v2.json)

const GatedStage = z.enum(SDLC_STAGES).refine((s) => s !== 'MAINTAIN', 'MAINTAIN has no gate');

export const RoleTemplateSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  for: z.string(),
  roles: z
    .array(
      z.object({
        key: z.string().regex(ROLE_KEY_PATTERN),
        name: z.string().min(1).max(ROLE_NAME_MAX_CHARS),
        system_kind: z.enum(['owner', 'observer']).nullable(),
        capabilities: z.array(CapabilityKey),
      }),
    )
    .min(1),
  gates: z.array(
    z.object({
      stage: GatedStage,
      mode: z.enum(['approval', 'auto', 'skip']),
      approver_roles: z.array(z.string()),
      min_approvals: z.number().int().min(1),
      min_distinct_roles: z.number().int().min(1),
      forbid_self_approval: z.boolean(),
      required_artifact_kind: z.string().nullable().optional(),
    }),
  ),
  agent_policy: z.record(z.string()),
});
export type RoleTemplate = z.infer<typeof RoleTemplateSchema>;

export const RoleTemplateFileSchema = z
  .object({
    version: z.string(),
    capabilities: z.array(z.string()),
    templates: z.array(RoleTemplateSchema).min(1),
  })
  .superRefine((file, ctx) => {
    for (const t of file.templates) {
      const keys = new Set(t.roles.map((r) => r.key));
      if (t.roles.filter((r) => r.system_kind === 'owner').length !== 1) {
        ctx.addIssue({ code: 'custom', message: `${t.key}: needs exactly one owner role` });
      }
      for (const g of t.gates) {
        for (const r of g.approver_roles) {
          if (!keys.has(r))
            ctx.addIssue({ code: 'custom', message: `${t.key}: unknown role ${r}` });
        }
        if (g.min_distinct_roles > g.min_approvals) {
          ctx.addIssue({ code: 'custom', message: `${t.key}: ${g.stage} distinct > approvals` });
        }
      }
    }
  });

export interface RoleTemplateList {
  items: RoleTemplate[];
}

// ---- stages a role works in (ADR-041)

/**
 * The stages a role works in by default, read from its key or name (template roles, new custom
 * roles, and the 0012 backfill, which mirrors these rules in SQL). First match wins.
 */
const STAGE_RULES: [RegExp, SdlcStage[]][] = [
  [/security/, ['TEST']],
  [/qa|test/, ['TEST']],
  [/sre|ops|release|deploy/, ['DEPLOY', 'MAINTAIN']],
  [/tech_lead|platform_lead/, ['DESIGN', 'BUILD']],
  [/manager|product|program|pm|stakeholder|analyst/, ['PLAN']],
  [/design|architect/, ['DESIGN']],
  [/engineer|dev|builder|coder/, ['BUILD']],
  [/research/, ['PLAN']],
];

export function defaultRoleStages(keyOrName: string): SdlcStage[] {
  const key = keyOrName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  for (const [pattern, stages] of STAGE_RULES) if (pattern.test(key)) return [...stages];
  return [];
}

/**
 * Who gets the handoff when the loop enters `stage`: the members of the roles that work in it, or
 * every member when no role does (pure; the API resolves role ids to members).
 */
export function handoffRecipients(
  roles: readonly { id: string; stages: readonly SdlcStage[] }[],
  stage: SdlcStage,
): { roleIds: string[] } | { members: true } {
  const roleIds = roles.filter((r) => r.stages.includes(stage)).map((r) => r.id);
  return roleIds.length > 0 ? { roleIds } : { members: true };
}
