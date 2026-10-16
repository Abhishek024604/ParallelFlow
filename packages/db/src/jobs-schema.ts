import pg from 'pg';
import { PgBoss } from 'pg-boss';

// pg-boss storage (ADR-033). Migration 0005 creates the empty `pgboss` schema, owned by the schema
// owner, with default privileges for saras_relay. `installJobSchema` then lets pg-boss create or
// upgrade its tables in it, as the owner, at the end of `pnpm db:migrate`. Runtime roles therefore
// need no CREATE anywhere: the worker starts pg-boss with `migrate: false`, which only checks that
// the installed version matches.

/** The schema pg-boss lives in. The worker passes the same name to `new PgBoss()`. */
export const JOB_SCHEMA = 'pgboss';

/**
 * Installs or upgrades pg-boss in JOB_SCHEMA as the owner, then grants saras_relay DML on what it
 * created (the default privileges from 0005 cover it too; this is idempotent and covers upgrades).
 * Requires migration 0005. Returns the installed pg-boss schema version.
 */
export async function installJobSchema(ownerUrl: string): Promise<number> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: JOB_SCHEMA,
    createSchema: false,
    migrate: true,
    supervise: false,
    schedule: false,
    max: 1,
  });
  let failure: Error | undefined;
  boss.on('error', (err) => {
    failure ??= err;
  });
  let version: number | null;
  try {
    await boss.start();
    version = await boss.schemaVersion();
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
  if (failure) throw failure;
  if (version === null) throw new Error('pg-boss schema was not installed');

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    await client.query(`
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${JOB_SCHEMA} TO saras_relay;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${JOB_SCHEMA} TO saras_relay;`);
  } finally {
    await client.end();
  }
  return version;
}
