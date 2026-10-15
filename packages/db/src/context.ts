// Request-scoped tenant context (doc 05 §5.5). Every query runs inside a transaction that first sets
// these with set_config(..., is_local = true), so they vanish at COMMIT/ROLLBACK and never leak to the
// next user of a pooled connection.

export interface TenantContext {
  orgId: string;
  userId: string;
}

export interface SystemJobContext {
  orgId: string;
}

/**
 * Workers act for no user. The RLS policies cast app.user_id to uuid, so it must always be a valid
 * uuid; the nil uuid matches no row in `users`.
 */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

const SEARCH_PATH = 'saras, public';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Settings = Record<
  'search_path' | 'app.org_id' | 'app.user_id' | 'app.system_job',
  string
>;

function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) {
    throw new Error(`Invalid tenant context: ${field} must be a uuid`);
  }
  return value;
}

export function tenantSettings(ctx: TenantContext): Settings {
  const userId = requireUuid(ctx.userId, 'userId');
  if (userId === SYSTEM_USER_ID) {
    throw new Error('Invalid tenant context: use withSystemJob for system work');
  }
  return {
    search_path: SEARCH_PATH,
    'app.org_id': requireUuid(ctx.orgId, 'orgId'),
    'app.user_id': userId,
    'app.system_job': 'off',
  };
}

export function systemJobSettings(ctx: SystemJobContext): Settings {
  return {
    search_path: SEARCH_PATH,
    'app.org_id': requireUuid(ctx.orgId, 'orgId'),
    'app.user_id': SYSTEM_USER_ID,
    'app.system_job': 'on',
  };
}
