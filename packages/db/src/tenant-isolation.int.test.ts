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

    it('the app cannot read message partitions directly, bypassing the parent policies', async () => {
      const { rows } = await query<{ relname: string }>(
        t.ownerUrl,
        `SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'saras.messages'::regclass ORDER BY 1`,
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const { relname } of rows) {
        await expect(
          query(t.appUrl, `SELECT 1 FROM saras.${ident(relname)} LIMIT 1`),
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe('allowed: own org', () => {
    it('the project owner sees org A rows in every tenant table, and only org A rows', async () => {
      const seen = await asA(async (tx) => {
        const out: Record<string, { all: number; own: number }> = {};
        for (const table of tables)
          out[table] = { all: await count(tx, table), own: await count(tx, table, a.orgId) };
        return out;
      });
      for (const table of tables) {
        expect(seen[table]!.all, `${table}: visible rows`).toBeGreaterThan(0);
        expect(seen[table]!.own, `${table}: visible rows that belong to org A`).toBe(
          seen[table]!.all,
        );
      }
    });
  });

  describe('denied: other org', () => {
    it('org B has data in every tenant table (so the checks below are meaningful)', async () => {
      const empty = await t.db.withSystemJob({ orgId: b.orgId }, async (tx) => {
        const out: string[] = [];
        for (const table of tables) if ((await count(tx, table)) === 0) out.push(table);
        return out;
      });
      expect(empty).toEqual([]);
    });

    it('reads 0 org B rows in every tenant table', async () => {
      const leaks = await asA(async (tx) => {
        const out: Record<string, number> = {};
        for (const table of tables) {
          const n = await count(tx, table, b.orgId);
          if (n) out[table] = n;
        }
        return out;
      });
      expect(leaks).toEqual({});
    });

    it('updates and deletes 0 org B rows in every tenant table', async () => {
      const touched = await asA(async (tx) => {
        const out: Record<string, bigint> = {};
        for (const table of tables) {
          const t1 = sql.table(table);
          const upd = await sql`UPDATE ${t1} SET org_id = org_id WHERE org_id = ${b.orgId}`.execute(
            tx,
          );
          const del = await sql`DELETE FROM ${t1} WHERE org_id = ${b.orgId}`.execute(tx);
          const n = (upd.numAffectedRows ?? 0n) + (del.numAffectedRows ?? 0n);
          if (n) out[table] = n;
        }
        return out;
      });
      expect(touched).toEqual({});
    });

    it('cannot move org A rows into org B in any tenant table', async () => {
      const results: Record<string, string> = {};
      for (const table of tables) {
        results[table] = await pgError(
          asA((tx) => sql`UPDATE ${sql.table(table)} SET org_id = ${b.orgId}`.execute(tx)),
        );
      }
      for (const table of tables) {
        // RLS WITH CHECK rejects with 42501; append-only tables are stopped earlier by their trigger.
        expect(results[table], table).toBe(APPEND_ONLY.has(table) ? 'P0001' : '42501');
      }
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
        const visible: Record<string, number> = {};
        for (const table of tables) {
          // A brand-new session sees app.org_id as NULL and reads 0 rows. Behind a pooler (Neon,
          // PgBouncer) the server session may have run withTenant before, leaving '' — the uuid cast
          // then fails (22P02). Both deny; only a positive count is a leak.
          const n = await client
            .query<{ n: number }>(`SELECT count(*)::int AS n FROM saras.${ident(table)}`)
            .then((r) => r.rows[0]!.n)
            .catch((err: { code?: string }) => {
              if (err.code === '22P02') return 0;
              throw err;
            });
          if (n) visible[table] = n;
        }
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
