import { CompiledQuery, Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import type { OutboxRecord } from './outbox.js';

// The outbox relay's database accessor (ADR-033, F21-05). The relay must read outbox rows of every
// org, which no app context can do (RLS limits each one to one org). It connects as a login role in
// `saras_relay` instead: no BYPASSRLS, owns nothing, and its grants and `TO saras_relay` policies
// (migration 0005) let it do exactly this:
//   outbox_events     SELECT every row; UPDATE only published_at, only from NULL to a value;
//                     DELETE only rows published more than 7 days ago
//   idempotency_keys  DELETE only expired rows; no SELECT, so it never reads stored responses
//   pgboss.*          DML on the job tables (pg-boss runs as this role)
// Nothing else in `saras`. The relay never sets app.* settings, so the schema_v2 tenant policies see
// NULL and add nothing. Use a DIRECT (non-pooled) URL: pg-boss on the same login needs advisory
// locks and session state.

/** Statements pg-boss runs inside the relay's transaction (its `db` option, IDatabase-compatible). */
export interface JobExecutor {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface RelayDatabase {
  /** Throws unless connected as a saras_relay member that is not superuser, BYPASSRLS, the owner or an app role. */
  assertRelayRole(): Promise<void>;
  /**
   * Claims up to `limit` unpublished rows (oldest first, FOR UPDATE SKIP LOCKED, so concurrent relays
   * never claim the same row), calls `enqueue` with them and a JobExecutor on the same transaction,
   * then marks them published. Everything commits together or not at all: a failure in `enqueue`
   * leaves the rows unpublished for the next poll. Returns how many rows were published.
   * Idle polls cost one query (no transaction is opened when nothing is pending).
   */
  publishBatch(
    limit: number,
    enqueue: (records: OutboxRecord[], jobs: JobExecutor) => Promise<void>,
  ): Promise<number>;
  /** Deletes up to `limit` rows published more than 7 days ago (doc 06 §6.6). Returns the count. */
  deletePublishedOutbox(limit?: number): Promise<number>;
  /** Deletes every expired idempotency record (F21-04 debt). The RLS policy picks the rows. */
  sweepExpiredIdempotencyKeys(): Promise<number>;
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

export interface RelayDatabaseOptions {
  /** RELAY_DATABASE_URL: a saras_relay login on a DIRECT endpoint. */
  connectionString?: string;
  /** Bring your own pool (tests). */
  pool?: pg.Pool;
  /** Called when the server drops an idle pooled connection. Error class and SQLSTATE only. */
  onIdleConnectionError?: (info: { name: string; code?: string }) => void;
}

/** Days a published outbox row is kept. Must match the relay_cleanup policy in migration 0005. */
export const OUTBOX_RETENTION_DAYS = 7;

const PENDING = sql`SELECT EXISTS (SELECT 1 FROM saras.outbox_events WHERE published_at IS NULL) AS pending`;

/** The claim statement: oldest unpublished rows, skipping rows another relay holds. */
export function claimBatchQuery(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Relay batch size must be an integer between 1 and 1000');
  }
  return sql<OutboxRecord>`
    SELECT id, org_id, topic, type, aggregate_id, payload, created_at
    FROM saras.outbox_events
    WHERE published_at IS NULL
    ORDER BY created_at, id
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`;
}

export function createRelayDatabase(options: RelayDatabaseOptions): RelayDatabase {
  const pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString });
  pool.on('error', (err: Error & { code?: string }) => {
    options.onIdleConnectionError?.(
      err.code ? { name: err.name, code: err.code } : { name: err.name },
    );
  });
  // No schema types: the relay touches two tables through the SQL below and nothing else.
  const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

  const executor = (tx: Transaction<unknown>): JobExecutor => ({
    async executeSql(text, values) {
      const result = await tx.executeQuery(CompiledQuery.raw(text, values ?? []));
      return { rows: [...result.rows] };
    },
  });

  return {
    async assertRelayRole() {
      const { rows } = await pool.query<{ ok: boolean }>(`
        SELECT NOT (r.rolsuper OR r.rolbypassrls)
           AND pg_has_role(current_user, 'saras_relay', 'MEMBER')
           AND NOT pg_has_role(current_user, 'saras_app', 'MEMBER')
           AND NOT pg_has_role(current_user, c.relowner, 'MEMBER') AS ok
        FROM pg_roles r, pg_class c
        WHERE r.rolname = current_user AND c.oid = 'saras.outbox_events'::regclass`);
      if (!rows[0]?.ok) {
        throw new Error(
          'Unsafe relay database role: connect as a saras_relay member that is not the owner, not a saras_app member, and has no SUPERUSER or BYPASSRLS (ADR-033)',
        );
      }
    },

    async publishBatch(limit, enqueue) {
      const query = claimBatchQuery(limit);
      const { rows } = await PENDING.execute(db);
      if (!(rows[0] as { pending: boolean } | undefined)?.pending) return 0;

      return db.transaction().execute(async (tx) => {
        const claimed = (await query.execute(tx)).rows;
        if (claimed.length === 0) return 0;
        await enqueue(claimed, executor(tx));
        const updated = await sql`
          UPDATE saras.outbox_events SET published_at = now()
          WHERE id = ANY(${claimed.map((r) => r.id)}::uuid[]) AND published_at IS NULL`.execute(tx);
        if (Number(updated.numAffectedRows ?? 0n) !== claimed.length) {
          // Cannot happen while the rows are locked; roll back rather than publish twice.
          throw new Error('Outbox rows changed while claimed');
        }
        return claimed.length;
      });
    },

    async deletePublishedOutbox(limit = 10_000) {
      const result = await sql`
        DELETE FROM saras.outbox_events WHERE id IN (
          SELECT id FROM saras.outbox_events
          WHERE published_at < now() - make_interval(days => ${OUTBOX_RETENTION_DAYS})
          LIMIT ${limit})`.execute(db);
      return Number(result.numAffectedRows ?? 0n);
    },

    async sweepExpiredIdempotencyKeys() {
      // No WHERE clause on purpose: the role has DELETE but no SELECT on this table, and the
      // relay_sweep policy limits the statement to expires_at < now().
      const result = await sql`DELETE FROM saras.idempotency_keys`.execute(db);
      return Number(result.numAffectedRows ?? 0n);
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    destroy: () => db.destroy(),
  };
}
