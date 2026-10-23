import type { Me, OrgRoleSchema } from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { z } from 'zod';

// GET / PATCH /me (openapi_v2.yaml #/components/schemas/Me). Runs in user scope (`withUser`,
// ADR-031): RLS shows only the caller's own row, own memberships, and orgs where the caller's
// membership is active, so nothing of another user can appear here.

type OrgRole = z.infer<typeof OrgRoleSchema>;

export interface MeUserRow {
  id: string;
  email: string;
  display_name: string;
  handle: string;
}

export interface MeOrgRow {
  id: string;
  slug: string;
  name: string;
  preset: string;
  unit_level_names: string[];
  data_region: string;
  created_at: Date;
  role: string;
  status: string;
  expires_at: Date | null;
}

const PRESETS = new Set(['startup', 'enterprise']);

/** Pure mapping from rows to the contract shape. */
export function toMe(user: MeUserRow, orgs: readonly MeOrgRow[]): Me {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    handle: user.handle,
    orgs: orgs.map((row) => ({
      org: {
        id: row.id,
        slug: row.slug,
        name: row.name,
        preset: (PRESETS.has(row.preset) ? row.preset : 'startup') as 'startup' | 'enterprise',
        unit_level_names: row.unit_level_names,
        data_region: row.data_region,
        // SSO is not built in the MVP (ADR-029); F01-02 reads it from the org's WorkOS connection.
        sso_enabled: false,
        created_at: row.created_at.toISOString(),
      },
      role: row.role as OrgRole,
      status: row.status,
      expires_at: row.expires_at ? row.expires_at.toISOString() : null,
    })),
    // Units are hidden in the MVP (ADR-029).
    unit_roles: [],
  };
}

/** The caller's profile and memberships. `tx` must be the caller's user scope. */
export async function loadMe(tx: Tx, userId: string): Promise<Me | undefined> {
  const user = await tx
    .selectFrom('users')
    .select(['id', 'email', 'display_name', 'handle'])
    .where('id', '=', userId)
    .where('deactivated_at', 'is', null)
    .executeTakeFirst();
  if (!user) return undefined;
  // Inner join: an org is visible in user scope only while the membership is active (0003 orgs_read).
  const orgs = await tx
    .selectFrom('org_memberships as m')
    .innerJoin('organizations as o', 'o.id', 'm.org_id')
    .select([
      'o.id',
      'o.slug',
      'o.name',
      'o.preset',
      'o.unit_level_names',
      'o.data_region',
      'o.created_at',
      'm.role',
      'm.status',
      'm.expires_at',
    ])
    .where('m.user_id', '=', userId)
    .orderBy('m.joined_at')
    .orderBy('o.id')
    .execute();
  return toMe(user, orgs);
}
