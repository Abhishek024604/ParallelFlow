import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaMigrator } from './migrator.js';
import { createEmptyTestDatabase, integrationEnabled, query } from './testing/database.js';

const enabled = await integrationEnabled();

interface Catalog {
  tables: number;
  forced_rls: number;
  tenant_policies: number;
  capabilities: number | null;
  app_schema_usage: boolean | null;
}

async function catalog(ownerUrl: string): Promise<Catalog> {
  const { rows } = await query<Catalog>(
    ownerUrl,
    `SELECT
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'saras' AND c.relkind IN ('r','p') AND NOT c.relispartition) AS tables,
       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'saras' AND c.relrowsecurity AND c.relforcerowsecurity) AS forced_rls,
       (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'saras' AND policyname = 'tenant_isolation') AS tenant_policies,
       (SELECT CASE WHEN to_regnamespace('saras') IS NOT NULL AND to_regrole('saras_app') IS NOT NULL
               THEN has_schema_privilege('saras_app', 'saras', 'USAGE') END) AS app_schema_usage`,
  );
  const result = rows[0] as Omit<Catalog, 'capabilities'>;
  const capabilities = result.tables
    ? (await query<{ n: number }>(ownerUrl, 'SELECT count(*)::int AS n FROM saras.capabilities'))
        .rows[0]!.n
    : null;
  return { ...result, capabilities };
}

describe.skipIf(!enabled)('migrations up/down', () => {
  let ownerUrl: string;
  let cleanup: () => Promise<void>;
  let migrator: SchemaMigrator;

  beforeAll(async () => {
    ({ ownerUrl, cleanup } = await createEmptyTestDatabase());
    migrator = new SchemaMigrator(ownerUrl);
  });

  afterAll(async () => {
    await migrator?.destroy();
    await cleanup?.();
  });

  it('up on an empty database applies every migration and builds schema_v2', async () => {
    const run = await migrator.latest();

    expect(run.applied).toEqual([
      '↑ 0001_baseline',
      '↑ 0002_app_role',
      '↑ 0003_identity_rls',
      '↑ 0004_request_pipeline',
    ]);
    // doc 06: 45 schema_v2 tables + 2 request-pipeline tables (F21-04), 27 seeded capabilities; RLS
    // forced on the 41 tenant tables (schema_v2), users and organizations (ADR-031), and
    // idempotency_keys and rate_limit_counters (F21-04).
    expect(await catalog(ownerUrl)).toEqual({
      tables: 47,
      forced_rls: 45,
      tenant_policies: 41,
      capabilities: 27,
      app_schema_usage: true,
    });
  });

  it('up again is a no-op', async () => {
    expect((await migrator.latest()).applied).toEqual([]);
  });

  it('down reverts one migration at a time, newest first', async () => {
    expect((await migrator.down()).applied).toEqual(['↓ 0004_request_pipeline']);
    expect(await catalog(ownerUrl)).toMatchObject({ tables: 45, forced_rls: 43 });

    expect((await migrator.down()).applied).toEqual(['↓ 0003_identity_rls']);
    expect((await catalog(ownerUrl)).forced_rls).toBe(41);

    expect((await migrator.down()).applied).toEqual(['↓ 0002_app_role']);
    expect((await catalog(ownerUrl)).app_schema_usage).toBe(false);

    expect((await migrator.down()).applied).toEqual(['↓ 0001_baseline']);
    expect(await catalog(ownerUrl)).toMatchObject({ tables: 0, forced_rls: 0, capabilities: null });
    expect(await migrator.applied()).toEqual([]);
  });

  it('up after a full down rebuilds the same schema', async () => {
    expect((await migrator.latest()).applied).toEqual([
      '↑ 0001_baseline',
      '↑ 0002_app_role',
      '↑ 0003_identity_rls',
      '↑ 0004_request_pipeline',
    ]);
    expect(await catalog(ownerUrl)).toMatchObject({ tables: 47, forced_rls: 45, capabilities: 27 });
  });
});
