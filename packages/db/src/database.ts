import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import {
  identitySettings,
  requireId,
  systemJobSettings,
  tenantSettings,
  userScopeSettings,
  type IdentityContext,
  type Settings,
  type SystemJobContext,
  type TenantContext,
  type UserContext,
} from './context.js';
import type { DB } from './schema.gen.js';

export type Tx = Transaction<DB>;

/**
 * The caller is not an active member of the org or project, or it does not exist. APIs map this to
 * 404, never 403, so they do not reveal what exists (doc 07 §7.1).
 */
export class NotVisibleError extends Error {
  readonly code = 'NOT_FOUND';
  constructor() {
    super('Not found');
    this.name = 'NotVisibleError';
  }
}

/**
 * The caller has a membership here, but it is not active: suspended, deprovisioned, or a guest past
 * `expires_at`. APIs map this to 403 MEMBERSHIP_INACTIVE (doc 05 §5.5, doc 07 §7.4). Only thrown to
 * someone who holds the membership row, so it reveals nothing they could not already see.
 */
export class MembershipInactiveError extends Error {
  readonly code = 'MEMBERSHIP_INACTIVE';
  constructor() {
    super('Membership inactive');
    this.name = 'MembershipInactiveError';
  }
}

export interface Membership {
  orgId: string;
}

export interface OrgMemberContext {
  orgId: string;
  userId: string;
}

export interface ProjectMemberContext {
  projectId: string;
  userId: string;
}

/**
 * The only way to query Saras data (doc 11 §11.2, ADR-031). There is deliberately no accessor for the
 * raw Kysely instance: every query runs in a transaction that set its context first.
 *
 * Request handlers use the verified forms: withUser, withIdentity, withOrgMember, withProjectMember.
 * withTenant trusts the org id it is given; it is for flows that create the org (create arena) and for
 * code that already holds a verified membership.
 */
export interface Database {
  /** Your own rows across orgs (home: my arenas, /me). No tenant data. */
  withUser<T>(ctx: UserContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Sign-up / login: only the account of the verified email. */
  withIdentity<T>(ctx: IdentityContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /**
   * Tenant context after checking an active org membership. Throws MembershipInactiveError if your own
   * membership is suspended, deprovisioned or an expired guest, otherwise NotVisibleError.
   */
  withOrgMember<T>(ctx: OrgMemberContext, fn: (tx: Tx, m: Membership) => Promise<T>): Promise<T>;
  /**
   * Tenant context for the project's org after checking project + active org membership. Throws like
   * withOrgMember.
   */
  withProjectMember<T>(
    ctx: ProjectMemberContext,
    fn: (tx: Tx, m: Membership) => Promise<T>,
  ): Promise<T>;
  /** Unchecked tenant context. See the note above. */
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withSystemJob<T>(ctx: SystemJobContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Throws unless connected as a member of saras_app that cannot bypass RLS. Call at startup. */
  assertAppRole(): Promise<void>;
  /** Liveness: one `SELECT 1` on the pool, outside any context. Reads no data. */
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

export interface DatabaseOptions {
  /** App-role URL (DATABASE_URL). A pooled endpoint is fine. */
  connectionString?: string;
  /** Bring your own pool (tests). */
  pool?: pg.Pool;
  /**
   * Called when the server drops an idle pooled connection (restart, failover, idle timeout,
   * DROP DATABASE). The pool discards that connection by itself. Receives the error class and
   * SQLSTATE only, never the message. Default: ignore.
   */
  onIdleConnectionError?: (info: { name: string; code?: string }) => void;
}

async function apply(tx: Tx, settings: Settings): Promise<void> {
  await sql`
    SELECT set_config('search_path', ${settings.search_path}, true),
           set_config('app.org_id', ${settings['app.org_id']}, true),
           set_config('app.user_id', ${settings['app.user_id']}, true),
           set_config('app.user_email', ${settings['app.user_email']}, true),
           set_config('app.system_job', ${settings['app.system_job']}, true)
  `.execute(tx);
}

// Active = status active and, for guests, not past expires_at (doc 03 §3.9).
const ACTIVE_MEMBERSHIP = sql`m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())`;
// Inactive = was let in once and is now shut out (doc 07 §7.4). `invited` has never been active: it
// is treated as no membership at all.
const INACTIVE_MEMBERSHIP = sql`(m.status IN ('suspended', 'deprovisioned')
  OR (m.status = 'active' AND m.expires_at IS NOT NULL AND m.expires_at <= now()))`;

interface MembershipLookup {
  /** The org of an active membership, if there is one. */
  active(tx: Tx): Promise<string | undefined>;
  /** Whether the user's own membership exists but is inactive. Runs only when `active` found none. */
  inactive(tx: Tx): Promise<boolean>;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  // Without a listener, an idle connection closed by the server is an uncaught 'error' event and
  // kills the process. The pool already removes the broken connection; just report it.
  pool.on('error', (err: Error & { code?: string }) => {
    options.onIdleConnectionError?.(
      err.code ? { name: err.name, code: err.code } : { name: err.name },
    );
  });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const inContext = <T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction().execute(async (tx) => {
      await apply(tx, settings);
      return fn(tx);
    });

  // Look the membership up in user scope (own rows only), then switch the same transaction to the
  // tenant context for that org. One transaction, so a revoked membership cannot slip in between.
  // User scope shows only the caller's own membership rows, so the inactive check cannot reveal
  // whether the org or project exists to someone who never belonged to it.
  const asMember = <T>(
    userId: string,
    lookup: MembershipLookup,
    fn: (tx: Tx, m: Membership) => Promise<T>,
  ): Promise<T> =>
    db.transaction().execute(async (tx) => {
      await apply(tx, userScopeSettings({ userId }));
      const orgId = await lookup.active(tx);
      if (!orgId) {
        throw (await lookup.inactive(tx)) ? new MembershipInactiveError() : new NotVisibleError();
      }
      await apply(tx, tenantSettings({ orgId, userId }));
      return fn(tx, { orgId });
    });

  return {
    withUser: (ctx, fn) => inContext(userScopeSettings(ctx), fn),
    withIdentity: (ctx, fn) => inContext(identitySettings(ctx), fn),
    withOrgMember: (ctx, fn) => {
      const orgId = requireId(ctx.orgId, 'orgId');
      return asMember(
        ctx.userId,
        {
          async active(tx) {
            const { rows } = await sql<{ org_id: string }>`
              SELECT m.org_id FROM org_memberships m
              WHERE m.org_id = ${orgId} AND m.user_id = ${ctx.userId} AND ${ACTIVE_MEMBERSHIP}`.execute(
              tx,
            );
            return rows[0]?.org_id;
          },
          async inactive(tx) {
            const { rows } = await sql`
              SELECT 1 FROM org_memberships m
              WHERE m.org_id = ${orgId} AND m.user_id = ${ctx.userId} AND ${INACTIVE_MEMBERSHIP}`.execute(
              tx,
            );
            return rows.length > 0;
          },
        },
        fn,
      );
    },
    withProjectMember: (ctx, fn) => {
      const projectId = requireId(ctx.projectId, 'projectId');
      return asMember(
        ctx.userId,
        {
          async active(tx) {
            const { rows } = await sql<{ org_id: string }>`
              SELECT m.org_id FROM project_members pm
              JOIN org_memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id
              WHERE pm.project_id = ${projectId} AND pm.user_id = ${ctx.userId} AND ${ACTIVE_MEMBERSHIP}`.execute(
              tx,
            );
            return rows[0]?.org_id;
          },
          async inactive(tx) {
            const { rows } = await sql`
              SELECT 1 FROM project_members pm
              JOIN org_memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id
              WHERE pm.project_id = ${projectId} AND pm.user_id = ${ctx.userId} AND ${INACTIVE_MEMBERSHIP}`.execute(
              tx,
            );
            return rows.length > 0;
          },
        },
        fn,
      );
    },
    withTenant: (ctx, fn) => inContext(tenantSettings(ctx), fn),
    withSystemJob: (ctx, fn) => inContext(systemJobSettings(ctx), fn),
    async assertAppRole() {
      const { rows } = await pool.query<{ unsafe: boolean; member: boolean }>(`
        SELECT r.rolsuper OR r.rolbypassrls AS unsafe,
               pg_has_role(current_user, 'saras_app', 'MEMBER') AS member
        FROM pg_roles r WHERE r.rolname = current_user`);
      const role = rows[0];
      if (!role || role.unsafe || !role.member) {
        throw new Error(
          'Unsafe database role: connect as a saras_app member without SUPERUSER or BYPASSRLS (ADR-030)',
        );
      }
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    destroy: () => db.destroy(),
  };
}
