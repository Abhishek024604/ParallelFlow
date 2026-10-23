import {
  type CompiledQuery,
  type DatabaseConnection,
  type Dialect,
  type Driver,
  type Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from 'kysely';
import type pg from 'pg';
import { timedRoundTrip } from './stats.js';

// A Kysely Postgres driver that saves round trips (the database can be 250 ms away):
//
//   - BEGIN is deferred and sent in the same simple-protocol message as the transaction's first
//     statement when that statement has no parameters (the context `set_config`, see database.ts).
//     Otherwise it goes on its own first, exactly like Kysely's driver. A transaction that runs no
//     statement sends neither BEGIN nor COMMIT.
//   - A parameterless statement may hold several statements (simple protocol). The result is the
//     last statement's, or every statement's rows for a query that starts with BATCH_MARKER.
//
// Everything else matches kysely's PostgresDriver. Statements with parameters always use the
// extended protocol, so values are never spliced into SQL here.

/** Prefix of a multi-statement query whose rows are `unknown[][]`: one array per statement. */
export const BATCH_MARKER = '/*parallelflow:batch*/';

type PgResult = pg.QueryResult<Record<string, unknown>>;

function toQueryResult<R>(result: PgResult): QueryResult<R> {
  const rows = (result.rows ?? []) as R[];
  if (
    result.command === 'INSERT' ||
    result.command === 'UPDATE' ||
    result.command === 'DELETE' ||
    result.command === 'MERGE'
  ) {
    return { numAffectedRows: BigInt(result.rowCount ?? 0), rows };
  }
  return { rows };
}

class Connection implements DatabaseConnection {
  /** BEGIN statement still to send, or undefined outside a not-yet-started transaction. */
  pendingBegin: string | undefined;
  /** A transaction is open on the server. */
  inTransaction = false;

  constructor(readonly client: pg.PoolClient) {}

  private send(text: string, params?: readonly unknown[]): Promise<PgResult | PgResult[]> {
    return timedRoundTrip(
      () =>
        this.client.query(text, params?.length ? [...params] : undefined) as unknown as Promise<
          PgResult | PgResult[]
        >,
    );
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    let text = query.sql;
    let prefixed = false;
    if (this.pendingBegin) {
      const begin = this.pendingBegin;
      this.pendingBegin = undefined;
      this.inTransaction = true;
      if (query.parameters.length === 0) {
        text = `${begin};\n${text}`;
        prefixed = true;
      } else {
        await this.send(begin);
      }
    }
    const raw = await this.send(text, query.parameters);
    let results = Array.isArray(raw) ? raw : [raw];
    if (prefixed) results = results.slice(1);
    if (text.startsWith(BATCH_MARKER) || query.sql.startsWith(BATCH_MARKER)) {
      return { rows: results.map((r) => r.rows ?? []) as R[] };
    }
    const last = results.at(-1);
    return last ? toQueryResult<R>(last) : { rows: [] };
  }

  // eslint-disable-next-line require-yield
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error('Streaming queries are not supported');
  }

  async end(statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    if (this.pendingBegin) {
      // Nothing ran: there is no transaction on the server to end.
      this.pendingBegin = undefined;
      return;
    }
    if (!this.inTransaction) return;
    this.inTransaction = false;
    await this.send(statement);
  }
}

class RoundTripSavingDriver implements Driver {
  constructor(private readonly pool: pg.Pool) {}

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new Connection(await this.pool.connect());
  }

  async beginTransaction(conn: DatabaseConnection, settings: TransactionSettings): Promise<void> {
    const c = conn as Connection;
    c.pendingBegin = settings.isolationLevel
      ? `BEGIN ISOLATION LEVEL ${settings.isolationLevel.toUpperCase()}`
      : 'BEGIN';
  }

  async commitTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as Connection).end('COMMIT');
  }

  async rollbackTransaction(conn: DatabaseConnection): Promise<void> {
    await (conn as Connection).end('ROLLBACK');
  }

  async releaseConnection(conn: DatabaseConnection): Promise<void> {
    (conn as Connection).client.release();
  }

  async destroy(): Promise<void> {
    await this.pool.end();
  }
}

export function roundTripSavingDialect(pool: pg.Pool): Dialect {
  return {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new RoundTripSavingDriver(pool),
    createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  };
}
