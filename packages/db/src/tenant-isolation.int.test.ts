import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Tx } from './database.js';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// Cross-tenant suite (F21-03, doc 11 §11.5): a member of org A, with a full tenant context, can never
// read, change or create org B data in any RLS table. Tables are read from the catalog, so a table
// added later is covered automatically.

const enabled = await integrationEnabled();
const APPEND_ONLY = new Set(['audit_events', 'stage_transitions', 'bridge_events']);

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

async function count(tx: Tx, table: string, orgId?: string): Promise<number> {
  const where = orgId ? sql`WHERE org_id = ${orgId}` : sql``;
  const { rows } = await sql<{
    n: number;
  }>`SELECT count(*)::int AS n FROM ${sql.table(table)} ${where}`.execute(tx);
  return rows[0]!.n;
}

// Round trips: each loop below covers all 41 tables in a constant number of round trips, never one
// (or one transaction) per table. On a remote server (e.g. Neon in us-east-2 from India, 0.4–0.5 s per
// round trip measured) the per-table versions took 25–60 s each, and the "move" check
// went over the 120 s test timeout. Each table is still checked on its own, as described per helper.

/** Visible rows per table (and, with `orgId`, how many of them belong to it), in one query. */
async function countEach(
  tx: Tx,
  tables: string[],
  orgId?: string,
): Promise<Record<string, { n: number; own: number }>> {
  const own = orgId ? sql`count(*) FILTER (WHERE org_id = ${orgId})::int` : sql`0`;
  const { rows } = await sql<{ t: string; n: number; own: number }>`${sql.join(
    tables.map(
      (table) =>
        sql`SELECT ${table}::text AS t, count(*)::int AS n, ${own} AS own FROM ${sql.table(table)}`,
    ),
    sql` UNION ALL `,
  )}`.execute(tx);
  expect(rows.map((r) => r.t).sort()).toEqual([...tables].sort());
  return Object.fromEntries(rows.map(({ t, n, own }) => [t, { n, own }]));
}

/** What one statement did: its SQLSTATE if it failed, otherwise the rows it affected or returned. */
interface Outcome {
  code: string | null;
  rows: number | null;
}

const PROBE_RESULT = 'saras_test.probe';

/**
 * Runs each statement in its own subtransaction (a PL/pgSQL exception block is SAVEPOINT / ROLLBACK
 * TO SAVEPOINT on the server) and always rolls it back, even when it succeeds. So a failure in one
 * statement cannot abort or mask the next, and no statement sees changes made by an earlier one.
 * The statements run as the session's role with its settings, so RLS and triggers apply exactly as
 * for a top-level statement. Two round trips for any number of statements.
 */
async function probe(
  run: (text: string) => Promise<{ rows: unknown[] }>,
  statements: string[],
): Promise<Outcome[]> {
  const list = statements.map((s) => pg.escapeLiteral(s)).join(',\n    ');
  await run(`DO $probe$
DECLARE
  stmts text[] := ARRAY[
    ${list}
  ]::text[];
  out jsonb := '[]';
  n bigint;
BEGIN
  FOR i IN 1 .. coalesce(array_length(stmts, 1), 0) LOOP
    n := NULL;
    BEGIN
      EXECUTE stmts[i];
      GET DIAGNOSTICS n = ROW_COUNT;
      RAISE EXCEPTION USING ERRCODE = 'TSTOK'; -- undo the statement even though it worked
    EXCEPTION WHEN OTHERS THEN
      out := out || jsonb_build_object('code', nullif(SQLSTATE, 'TSTOK'), 'rows', n);
    END;
  END LOOP;
  PERFORM set_config('${PROBE_RESULT}', out::text, true);
END
$probe$`);
  const { rows } = await run(`SELECT current_setting('${PROBE_RESULT}') AS out`);
  const outcomes = JSON.parse((rows[0] as { out: string }).out) as Outcome[];
  expect(outcomes).toHaveLength(statements.length);
  return outcomes;
}

const inTx = (tx: Tx) => (text: string) => sql.raw(text).execute(tx);

/** One outcome per table, keyed by table name, so a failure names every table that is wrong. */
const byTable = <T>(tables: string[], values: T[]) =>
  Object.fromEntries(tables.map((table, i) => [table, values[i]!]));

async function pgError(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'no error';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

describe.skipIf(!enabled)('tenant isolation (RLS)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  let tables: string[];

  const asA = <T>(fn: (tx: Tx) => Promise<T>) =>
    t.db.withTenant({ orgId: a.orgId, userId: a.users.owner }, fn);

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    const { rows } = await query<{ relname: string }>(
      t.ownerUrl,
      `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'org_id' AND NOT att.attisdropped
       WHERE n.nspname = 'saras' AND c.relkind IN ('r','p') AND NOT c.relispartition AND c.relrowsecurity
       ORDER BY 1`,
    );
    tables = rows.map((r) => r.relname);
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('database role', () => {
    it('the app connects as a saras_app member that cannot bypass RLS', async () => {
      await expect(t.db.assertAppRole()).resolves.toBeUndefined();
    });

    it('refuses to run as the schema owner', async () => {
      const owner = createDatabase({ connectionString: t.ownerUrl });
      try {
        await expect(owner.assertAppRole()).rejects.toThrow(/Unsafe database role/);
      } finally {
        await owner.destroy();
      }
    });
  });

  describe('catalog', () => {
    it('all 41 tenant tables have forced RLS', () => {
      expect(tables).toHaveLength(41);
    });

    it('every table the app can read that has org_id is protected by forced RLS', async () => {
      const { rows } = await query<{ relname: string }>(
        t.ownerUrl,
        `SELECT c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute att ON att.attrelid = c.oid AND att.attname = 'org_id' AND NOT att.attisdropped
         WHERE n.nspname = 'saras' AND c.relkind IN ('r','p','v')
           AND has_table_privilege('saras_app', c.oid, 'SELECT')
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
           AND NOT (c.relkind = 'v' AND 'security_invoker=true' = ANY (coalesce(c.reloptions, '{}')))`,
      );
      expect(rows.map((r) => r.relname)).toEqual([]);
    });

    it('every table the app can read has forced RLS, except the two global system tables', async () => {
      // Covers tables without org_id too (users, organizations, idempotency_keys,
      // rate_limit_counters). Adding a table without RLS has to be a deliberate change here.
      const { rows } = await query<{ relname: string }>(
        t.ownerUrl,
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'saras' AND c.relkind IN ('r','p','v') AND NOT c.relispartition
           AND has_table_privilege('saras_app', c.oid, 'SELECT')
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
           AND NOT (c.relkind = 'v' AND 'security_invoker=true' = ANY (coalesce(c.reloptions, '{}')))
         ORDER BY 1`,
      );
      // capabilities: read-only catalogue (ADR-020). processed_events: consumer dedupe ids, no content.
      expect(rows.map((r) => r.relname)).toEqual(['capabilities', 'processed_events']);
    });

    it('the app cannot read message partitions directly, bypassing the parent policies', async () => {
      const { rows } = await query<{ relname: string }>(
        t.ownerUrl,
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'saras.messages'::regclass ORDER BY 1`,
      );
      expect(rows.length).toBeGreaterThan(0);
      // One connection for all partitions: each statement runs (and fails) in its own implicit
      // transaction, so the checks stay independent without a remote connect per partition.
      const client = new pg.Client({ connectionString: t.appUrl });
      await client.connect();
      try {
        for (const { relname } of rows) {
          await expect(
            client.query(`SELECT 1 FROM saras.${ident(relname)} LIMIT 1`),
          ).rejects.toThrow(/permission denied/);
        }
      } finally {
        await client.end();
      }
    });
  });

  describe('allowed: own org', () => {
    it('the project owner sees org A rows in every tenant table, and only org A rows', async () => {
      const seen = await asA((tx) => countEach(tx, tables, a.orgId));
      for (const table of tables) {
        expect(seen[table]!.n, `${table}: visible rows`).toBeGreaterThan(0);
        expect(seen[table]!.own, `${table}: visible rows that belong to org A`).toBe(
          seen[table]!.n,
        );
      }
    });
  });

  describe('denied: other org', () => {
    it('org B has data in every tenant table (so the checks below are meaningful)', async () => {
      const seen = await t.db.withSystemJob({ orgId: b.orgId }, (tx) => countEach(tx, tables));
      expect(tables.filter((table) => seen[table]!.n === 0)).toEqual([]);
    });

    it('reads 0 org B rows in every tenant table', async () => {
      const seen = await asA((tx) => countEach(tx, tables, b.orgId));
      expect(tables.filter((table) => seen[table]!.own !== 0)).toEqual([]);
    });

    it('updates and deletes 0 org B rows in every tenant table', async () => {
      const lit = pg.escapeLiteral(b.orgId);
      const [updates, deletes] = await asA(async (tx) => [
        await probe(
          inTx(tx),
          tables.map(
            (table) => `UPDATE saras.${ident(table)} SET org_id = org_id WHERE org_id = ${lit}`,
          ),
        ),
        await probe(
          inTx(tx),
          tables.map((table) => `DELETE FROM saras.${ident(table)} WHERE org_id = ${lit}`),
        ),
      ]);
      // Each statement must succeed and touch nothing: no error, 0 rows.
      const none = byTable(
        tables,
        tables.map(() => ({ code: null, rows: 0 })),
      );
      expect(byTable(tables, updates)).toEqual(none);
      expect(byTable(tables, deletes)).toEqual(none);
    });

    it('cannot move org A rows into org B in any tenant table', async () => {
      const outcomes = await asA((tx) =>
        probe(
          inTx(tx),
          tables.map(
            (table) => `UPDATE saras.${ident(table)} SET org_id = ${pg.escapeLiteral(b.orgId)}`,
          ),
        ),
      );
      // RLS WITH CHECK rejects with 42501; append-only tables are stopped earlier by their trigger.
      expect(
        byTable(
          tables,
          outcomes.map((o) => o.code ?? 'no error'),
        ),
      ).toEqual(
        byTable(
          tables,
          tables.map((table) => (APPEND_ONLY.has(table) ? 'P0001' : '42501')),
        ),
      );
    });

    it.each([
      [
        'projects',
        (o: string, f: TenantFixture) =>
          sql`INSERT INTO projects (org_id, team_id, key, name, created_by) VALUES (${o}, ${f.projectId}, 'X', 'X', ${f.users.owner})`,
      ],
      [
        'messages',
        (o: string, f: TenantFixture) =>
          sql`INSERT INTO messages (org_id, arena_id, author_type, author_id, body) VALUES (${o}, ${f.arenaId}, 'user', ${f.users.owner}, 'x')`,
      ],
      [
        'tasks',
        (o: string, f: TenantFixture) =>
          sql`INSERT INTO tasks (org_id, project_id, title, created_by) VALUES (${o}, ${f.projectId}, 'x', ${f.users.owner})`,
      ],
      [
        'notifications',
        (o: string, f: TenantFixture) =>
          sql`INSERT INTO notifications (org_id, user_id, type, title, resource_type, resource_id, deep_link, dedupe_key)
            VALUES (${o}, ${f.users.owner}, 'system', 'x', 'project', ${f.projectId}, '/', 'x')`,
      ],
    ])('cannot insert %s rows into org B', async (_table, insert) => {
      expect(await pgError(asA((tx) => insert(b.orgId, b).execute(tx)))).toBe('42501');
    });
  });

  describe('denied: no tenant context', () => {
    it('a connection that never set a context reads nothing', async () => {
      const client = new pg.Client({ connectionString: t.appUrl });
      await client.connect();
      try {
        // BEGIN/ROLLBACK only scope the probe's result setting; no app.* context is ever set.
        await client.query('BEGIN');
        const [control, ...outcomes] = await probe(
          (text) => client.query(text),
          [
            // Control: proves the probe reports the rows a SELECT returns, so 0 below means 0.
            'SELECT FROM generate_series(1, 3)',
            ...tables.map((table) => `SELECT FROM saras.${ident(table)}`),
          ],
        );
        await client.query('ROLLBACK');
        expect(control).toEqual({ code: null, rows: 3 });
        // A brand-new session sees app.org_id as NULL and reads 0 rows. Behind a pooler (Neon,
        // PgBouncer) the server session may have run withTenant before, leaving '' — the uuid cast
        // then fails (22P02). Both deny; any visible row or any other error fails the test.
        const denied = (o: Outcome) => (o.code === null && o.rows === 0) || o.code === '22P02';
        const visible = Object.fromEntries(
          tables.flatMap((table, i) => (denied(outcomes[i]!) ? [] : [[table, outcomes[i]]])),
        );
        expect(visible).toEqual({});
      } finally {
        await client.end();
      }
    });

    it('the context does not leak to the next user of a pooled connection', async () => {
      const pool = new pg.Pool({ connectionString: t.appUrl, max: 1 });
      const db = createDatabase({ pool });
      try {
        expect(
          await db.withTenant({ orgId: a.orgId, userId: a.users.owner }, (tx) =>
            count(tx, 'projects'),
          ),
        ).toBe(1);

        // Same physical connection, no context: the settings were transaction-local.
        const leaked = await pool
          .query<{ n: number }>('SELECT count(*)::int AS n FROM saras.projects')
          .then((r) => r.rows[0]!.n)
          // '' is not a uuid: failing closed with 22P02 is also fine; any other error is not.
          .catch((err: { code?: string }) => {
            if (err.code === '22P02') return 0;
            throw err;
          });
        expect(leaked).toBe(0);

        expect(
          await db.withTenant({ orgId: b.orgId, userId: b.users.owner }, (tx) =>
            count(tx, 'projects', a.orgId),
          ),
        ).toBe(0);
      } finally {
        await db.destroy();
      }
    });
  });
});
