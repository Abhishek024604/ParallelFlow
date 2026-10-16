import { Kysely, sql, type Transaction } from 'kysely';
import pg from 'pg';
import {
  identitySettings,
  NIL_UUID,
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
import { BATCH_MARKER, roundTripSavingDialect } from './driver.js';
import type { DB } from './schema.gen.js';
import { timedRoundTrip } from './stats.js';

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

/** Request counts of the current rate-limit window (see Database.countRequest). */
export interface RequestCounts {
  user: number;
  org?: number;
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
  /**
   * Counts one request in the fixed rate-limit window starting at `windowStart` (rate_limit_counters,
   * doc 07 §7.1) and drops older windows of the same subjects. Its own transaction, committed at
   * once, in one round trip. Without `orgId` it runs in the user's scope; with `orgId` (which must
   * come from a membership verified for this request) in that org's tenant context, counting both.
   */
  countRequest(ctx: { userId: string; orgId?: string }, windowStart: Date): Promise<RequestCounts>;
  /** Throws unless connected as a member of saras_app that cannot bypass RLS. Call at startup. */
  assertAppRole(): Promise<void>;
  /** Opens `connections` pooled connections now, so the first requests do not pay for them. */
  warmUp(connections?: number): Promise<void>;
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

/**
 * Pool settings. A new connection to a remote database costs several round trips (TCP, TLS, auth),
 * so connections are kept open and reused: idle ones live for 10 minutes, with TCP keep-alive so a
 * dead one is noticed.
 */
export const POOL_DEFAULTS = {
  max: 20,
  idleTimeoutMillis: 10 * 60_000,
  connectionTimeoutMillis: 15_000,
  keepAlive: true,
  keepAliveInitialDelayMillis: 30_000,
} satisfies pg.PoolConfig;

/**
 * A SQL string literal. Used only for values the context functions have already validated (uuids,
 * emails, fixed words) and for opaque keys, so that a context switch can share a round trip with
 * other statements in one simple-protocol query. pg's escapeLiteral handles quotes and backslashes.
 */
export function sqlLiteral(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid SQL literal');
  return pg.escapeLiteral(value);
}

/** `('id1', 'id2')`: validated non-nil uuids only. */
export function uuidList(ids: readonly string[]): string {
  if (ids.length === 0) throw new Error('uuidList needs at least one id');
  return `(${ids.map((id) => sqlLiteral(requireId(id, 'id'))).join(', ')})`;
}

/** The context statement: one `SELECT set_config(...)` with literal values. */
function settingsSql(settings: Settings): string {
  const set = (name: keyof Settings) =>
    `set_config(${sqlLiteral(name)}, ${sqlLiteral(settings[name])}, true)`;
  return `SELECT ${set('search_path')}, ${set('app.org_id')}, ${set('app.user_id')}, ${set(
    'app.user_email',
  )}, ${set('app.system_job')}`;
}

async function apply(tx: Tx, settings: Settings): Promise<void> {
  // No parameters, so the driver can send it together with BEGIN (driver.ts).
  await sql.raw(settingsSql(settings)).execute(tx);
}

// Active = status active and, for guests, not past expires_at (doc 03 §3.9).
const ACTIVE_MEMBERSHIP = `m.status = 'active' AND (m.expires_at IS NULL OR m.expires_at > now())`;
// Inactive = was let in once and is now shut out (doc 07 §7.4). `invited` has never been active: it
// is treated as no membership at all.
const INACTIVE_MEMBERSHIP = `(m.status IN ('suspended', 'deprovisioned')
  OR (m.status = 'active' AND m.expires_at IS NOT NULL AND m.expires_at <= now()))`;

/** SQL (literal values only) of the membership rows behind a project or org context. */
interface MembershipLookup {
  /** `SELECT m.org_id FROM ...` of the active membership, if there is one. */
  active: string;
  /** `SELECT 1 FROM ...`: the user's own membership exists but is inactive. */
  inactive: string;
}

function projectLookup(projectId: string, userId: string): MembershipLookup {
  const from = `FROM project_members pm
    JOIN org_memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id
    WHERE pm.project_id = ${sqlLiteral(requireId(projectId, 'projectId'))}
      AND pm.user_id = ${sqlLiteral(requireId(userId, 'userId'))}`;
  return {
    active: `SELECT m.org_id ${from} AND ${ACTIVE_MEMBERSHIP}`,
    inactive: `SELECT 1 ${from} AND ${INACTIVE_MEMBERSHIP}`,
  };
}

function orgLookup(orgId: string, userId: string): MembershipLookup {
  const from = `FROM org_memberships m
    WHERE m.org_id = ${sqlLiteral(requireId(orgId, 'orgId'))}
      AND m.user_id = ${sqlLiteral(requireId(userId, 'userId'))}`;
  return {
    active: `SELECT m.org_id ${from} AND ${ACTIVE_MEMBERSHIP}`,
    inactive: `SELECT 1 ${from} AND ${INACTIVE_MEMBERSHIP}`,
  };
}

/**
 * Verifies the membership and switches `tx` to the tenant context of its org, in one round trip:
 *
 *   1. user scope (own rows only, ADR-031)
 *   2. the active membership row, whose org id goes into app.org_id as it is read
 *
 * Tenant and user scope differ only in app.org_id, so (2) leaves exactly tenantSettings({ orgId,
 * userId }). The lookup is on a unique key (project_id, user_id) / (org_id, user_id), so it yields at
 * most one row and the setting changes only after the scan has produced it; when there is no row
 * nothing changes and the transaction stays in user scope. User scope shows only the caller's own
 * membership rows, so the inactive check cannot reveal whether the org or project exists to someone
 * who never belonged to it. One transaction, so a revoked membership cannot slip in between.
 */
async function enterMember(tx: Tx, userId: string, lookup: MembershipLookup): Promise<Membership> {
  const { rows } = await sql
    .raw<{ org_id: string }>(
      `${settingsSql(userScopeSettings({ userId }))};
       SELECT set_config('app.org_id', f.org_id::text, true) AS org_id
         FROM (${lookup.active} LIMIT 1) f`,
    )
    .execute(tx);
  const orgId = rows[0]?.org_id;
  if (!orgId || orgId === NIL_UUID) {
    const inactive = await sql.raw(lookup.inactive).execute(tx);
    throw inactive.rows.length > 0 ? new MembershipInactiveError() : new NotVisibleError();
  }
  return { orgId: requireId(orgId, 'orgId') };
}

/**
 * The bridge (ADR-034): moves a transaction that is in the caller's user scope (db.withUser, the
 * pipeline's unscoped routes) into the verified tenant context of one project, after the same check
 * as withProjectMember (non-member → NotVisibleError, inactive → MembershipInactiveError). One
 * transaction, so a Push copies into the arena and binds the private chat atomically. Call
 * enterUserScope afterwards to go back to the caller's own rows.
 */
export async function enterProjectMember(tx: Tx, ctx: ProjectMemberContext): Promise<Membership> {
  return enterMember(tx, ctx.userId, projectLookup(ctx.projectId, ctx.userId));
}

/** Back to the caller's user scope in the same transaction (see enterProjectMember). */
export async function enterUserScope(tx: Tx, ctx: UserContext): Promise<void> {
  await apply(tx, userScopeSettings(ctx));
}

/**
 * One read in each of your arenas, from a user-scope transaction, in two round trips whatever the
 * number of arenas (instead of a transaction per arena):
 *
 *   1. your active project memberships (user scope: own rows only), grouped by org
 *   2. for each org: its tenant context, then `sqlFor(<its project ids>)`; finally user scope again
 *
 * Every tenant context comes from a membership verified in (1), in this same transaction, like
 * enterProjectMember. `sqlFor` gets a uuid list such as `('…', '…')` and must return one statement
 * with literal values only (use sqlLiteral / uuidList). Returns the rows of every org's statement.
 */
export async function readInEachMemberProject<R>(
  tx: Tx,
  userId: string,
  sqlFor: (projectIds: string) => string,
): Promise<R[]> {
  const user = userScopeSettings({ userId });
  const { rows } = await sql
    .raw<unknown[]>(
      `${BATCH_MARKER}${settingsSql(user)};
       SELECT pm.project_id, m.org_id FROM project_members pm
         JOIN org_memberships m ON m.org_id = pm.org_id AND m.user_id = pm.user_id
        WHERE pm.user_id = ${sqlLiteral(user['app.user_id'])} AND ${ACTIVE_MEMBERSHIP}`,
    )
    .execute(tx);
  const memberships = (rows.at(-1) ?? []) as { project_id: string; org_id: string }[];
  const byOrg = new Map<string, string[]>();
  for (const { project_id, org_id } of memberships) {
    byOrg.set(org_id, [...(byOrg.get(org_id) ?? []), project_id]);
  }
  if (byOrg.size === 0) return [];
  const statements: string[] = [];
  for (const [orgId, projectIds] of byOrg) {
    statements.push(settingsSql(tenantSettings({ orgId, userId })), sqlFor(uuidList(projectIds)));
  }
  statements.push(settingsSql(user));
  const batch = await sql.raw<unknown[]>(`${BATCH_MARKER}${statements.join(';\n')}`).execute(tx);
  // Results alternate: context, read, context, read, …, user scope.
  return batch.rows.filter((_, i) => i % 2 === 1).flat() as R[];
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool =
    options.pool ?? new pg.Pool({ connectionString: options.connectionString, ...POOL_DEFAULTS });
  // Rate-limit counts run while the request's own transaction holds a connection, so they get a
  // small pool of their own: a burst of requests can never use up every connection and wait forever.
  const counterPool =
    options.pool ??
    new pg.Pool({ connectionString: options.connectionString, ...POOL_DEFAULTS, max: 4 });
  // Without a listener, an idle connection closed by the server is an uncaught 'error' event and
  // kills the process. The pool already removes the broken connection; just report it.
  const onError = (err: Error & { code?: string }) => {
    options.onIdleConnectionError?.(
      err.code ? { name: err.name, code: err.code } : { name: err.name },
    );
  };
  pool.on('error', onError);
  if (counterPool !== pool) counterPool.on('error', onError);
  const db = new Kysely<DB>({ dialect: roundTripSavingDialect(pool) });

  const inContext = <T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction().execute(async (tx) => {
      await apply(tx, settings);
      return fn(tx);
    });

  const asMember = <T>(
    userId: string,
    lookup: MembershipLookup,
    fn: (tx: Tx, m: Membership) => Promise<T>,
  ): Promise<T> =>
    db.transaction().execute(async (tx) => fn(tx, await enterMember(tx, userId, lookup)));

  return {
    withUser: (ctx, fn) => inContext(userScopeSettings(ctx), fn),
    withIdentity: (ctx, fn) => inContext(identitySettings(ctx), fn),
    withOrgMember: (ctx, fn) => asMember(ctx.userId, orgLookup(ctx.orgId, ctx.userId), fn),
    withProjectMember: (ctx, fn) =>
      asMember(ctx.userId, projectLookup(ctx.projectId, ctx.userId), fn),
    withTenant: (ctx, fn) => inContext(tenantSettings(ctx), fn),
    withSystemJob: (ctx, fn) => inContext(systemJobSettings(ctx), fn),
    async countRequest(ctx, windowStart) {
      const settings = ctx.orgId
        ? tenantSettings({ orgId: ctx.orgId, userId: ctx.userId })
        : userScopeSettings({ userId: ctx.userId });
      const start = sqlLiteral(windowStart.toISOString());
      const subjects: [string, string][] = [['user', settings['app.user_id']]];
      if (ctx.orgId) subjects.push(['org', settings['app.org_id']]);
      const values = subjects
        .map(
          ([bucket, id]) => `(${sqlLiteral(bucket)}, ${sqlLiteral(id)}, ${start}::timestamptz, 1)`,
        )
        .join(', ');
      const mine = subjects
        .map(
          ([bucket, id]) => `(bucket = ${sqlLiteral(bucket)} AND subject_id = ${sqlLiteral(id)})`,
        )
        .join(' OR ');
      // One simple-protocol message: its own transaction, committed before the handler runs, so
      // failed requests still count and no counter row stays locked while a handler works.
      const text = `BEGIN;
        ${settingsSql(settings)};
        INSERT INTO rate_limit_counters (bucket, subject_id, window_start, hits) VALUES ${values}
          ON CONFLICT (bucket, subject_id, window_start)
          DO UPDATE SET hits = rate_limit_counters.hits + 1
          RETURNING bucket, hits;
        DELETE FROM rate_limit_counters WHERE (${mine}) AND window_start < ${start}::timestamptz;
        COMMIT`;
      const client = await counterPool.connect();
      let results: pg.QueryResult<{ bucket: string; hits: number }>[];
      try {
        results = (await timedRoundTrip(() => client.query(text))) as unknown as typeof results;
      } catch (err) {
        // The failed statement aborted the transaction: end it before the connection is reused.
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
        throw err;
      }
      client.release();
      const counted = results[2]?.rows ?? [];
      const user = counted.find((r) => r.bucket === 'user')?.hits;
      if (user === undefined) throw new Error('Rate-limit upsert returned no row');
      const org = counted.find((r) => r.bucket === 'org')?.hits;
      return org === undefined ? { user } : { user, org };
    },
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
    async warmUp(connections = 4) {
      const open = (p: pg.Pool, n: number) => Array.from({ length: n }, () => p.connect());
      const clients = await Promise.all([
        ...open(pool, connections),
        ...(counterPool === pool ? [] : open(counterPool, 2)),
      ]);
      for (const client of clients) client.release();
    },
    async ping() {
      await timedRoundTrip(() => pool.query('SELECT 1'));
    },
    async destroy() {
      await db.destroy();
      if (counterPool !== pool) await counterPool.end();
    },
  };
}
