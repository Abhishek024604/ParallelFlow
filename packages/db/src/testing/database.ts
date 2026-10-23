import { randomBytes } from 'node:crypto';
import { dockerAvailable, startPostgres } from '@parallelflow/testing';
import pg from 'pg';
import { createDatabase, type Database } from '../database.js';
import { installJobSchema } from '../jobs-schema.js';
import { SchemaMigrator } from '../migrator.js';
import { createRelayDatabase, type RelayDatabase } from '../relay.js';
import { ensureAppLogin, ensureRelayLogin } from '../roles.js';

// Integration tests need a throwaway database. Two sources:
//  - TEST_DATABASE_URL: an owner URL on an existing server (e.g. a Neon branch, direct endpoint).
//    Each test file creates its own `parallelflow_test_*` database there and drops it afterwards.
//  - otherwise Testcontainers starts Postgres 16 + pgvector (CI).

export async function integrationEnabled(): Promise<boolean> {
  return Boolean(process.env.TEST_DATABASE_URL) || dockerAvailable();
}

export interface TestDatabase {
  /** Owner of the schema. Bypasses RLS on most servers: only for setup and assertions on catalog. */
  ownerUrl: string;
  /** saras_app member: what the API uses. Set when `migrate` is true. */
  appUrl: string;
  /** createDatabase(appUrl). Set when `migrate` is true. */
  db: Database;
  /** saras_relay member (ADR-033). Set with `{ relay: true }`. */
  relayUrl?: string;
  /** createRelayDatabase(relayUrl). Set with `{ relay: true }`. */
  relay?: RelayDatabase;
  cleanup(): Promise<void>;
}

export interface TestDatabaseOptions {
  /**
   * Also install the pg-boss schema and provision a saras_relay login (outbox relay tests). Off by
   * default: it adds a pg-boss install to every test file that does not need it.
   */
  relay?: boolean;
}

function suffix(): string {
  return randomBytes(6).toString('hex');
}

async function withClient<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function freshServerDatabase(): Promise<{ ownerUrl: string; drop: () => Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (adminUrl) {
    const name = `parallelflow_test_${suffix()}`;
    await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${c.escapeIdentifier(name)}`));
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return {
      ownerUrl: url.toString(),
      drop: () =>
        withClient(adminUrl, (c) =>
          c.query(`DROP DATABASE IF EXISTS ${c.escapeIdentifier(name)} WITH (FORCE)`),
        ).then(() => undefined),
    };
  }
  const postgres = await startPostgres();
  return { ownerUrl: postgres.url, drop: () => postgres.container.stop().then(() => undefined) };
}

/** A fresh, empty database. The caller runs migrations itself. */
export async function createEmptyTestDatabase(): Promise<
  Pick<TestDatabase, 'ownerUrl' | 'cleanup'>
> {
  const { ownerUrl, drop } = await freshServerDatabase();
  return { ownerUrl, cleanup: drop };
}

/** A fresh database at the latest migration, plus a dedicated app login role (and relay login). */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const { ownerUrl, drop } = await freshServerDatabase();

  const migrator = new SchemaMigrator(ownerUrl);
  try {
    await migrator.latest();
  } finally {
    await migrator.destroy();
  }

  const role = `parallelflow_test_${suffix()}`;
  const appUrl = new URL(ownerUrl);
  appUrl.username = role;
  appUrl.password = randomBytes(24).toString('hex');
  await ensureAppLogin(ownerUrl, appUrl.toString());
  const roles = [role];

  let relayUrl: URL | undefined;
  let relay: RelayDatabase | undefined;
  if (options.relay) {
    await installJobSchema(ownerUrl);
    const relayRole = `parallelflow_test_relay_${suffix()}`;
    relayUrl = new URL(ownerUrl);
    relayUrl.username = relayRole;
    relayUrl.password = randomBytes(24).toString('hex');
    await ensureRelayLogin(ownerUrl, relayUrl.toString(), appUrl.toString());
    roles.push(relayRole);
    relay = createRelayDatabase({ connectionString: relayUrl.toString() });
  }

  const db = createDatabase({ connectionString: appUrl.toString() });
  return {
    ownerUrl,
    appUrl: appUrl.toString(),
    db,
    ...(relayUrl && relay && { relayUrl: relayUrl.toString(), relay }),
    async cleanup() {
      await db.destroy();
      await relay?.destroy();
      await drop();
      if (process.env.TEST_DATABASE_URL) {
        // Roles are cluster-wide on a shared server; containers are discarded whole.
        await withClient(process.env.TEST_DATABASE_URL, async (c) => {
          for (const r of roles) await c.query(`DROP ROLE IF EXISTS ${c.escapeIdentifier(r)}`);
        });
      }
    },
  };
}

/** Run one query on a plain connection (owner or app URL), outside any tenant context. */
export function query<R extends pg.QueryResultRow>(
  url: string,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  return withClient(url, (c) => c.query<R>(text, values));
}
