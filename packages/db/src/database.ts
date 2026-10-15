import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import {
  systemJobSettings,
  tenantSettings,
  type Settings,
  type SystemJobContext,
  type TenantContext,
} from './context.js';
import type { DB } from './schema.gen.js';

export type Tx = Transaction<DB>;

/**
 * The only way to query Saras data (doc 11 §11.2). There is deliberately no accessor for the raw
 * Kysely instance: every query runs in a transaction that has set the tenant context first, so RLS
 * always has app.org_id / app.user_id to check.
 */
export interface Database {
  withTenant<T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  withSystemJob<T>(ctx: SystemJobContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Throws unless connected as a member of saras_app that cannot bypass RLS. Call at startup. */
  assertAppRole(): Promise<void>;
  destroy(): Promise<void>;
}

export interface DatabaseOptions {
  /** App-role URL (DATABASE_URL). A pooled endpoint is fine. */
  connectionString?: string;
  /** Bring your own pool (tests). */
  pool?: pg.Pool;
}

export function createDatabase(options: DatabaseOptions): Database {
  const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });

  const inContext = <T>(settings: Settings, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    db.transaction().execute(async (tx) => {
      await sql`
        SELECT set_config('search_path', ${settings.search_path}, true),
               set_config('app.org_id', ${settings['app.org_id']}, true),
               set_config('app.user_id', ${settings['app.user_id']}, true),
               set_config('app.system_job', ${settings['app.system_job']}, true)
      `.execute(tx);
      return fn(tx);
    });

  return {
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
    destroy: () => db.destroy(),
  };
}
