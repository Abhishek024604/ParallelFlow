import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// The arena's memory (ADR-045, migration 0017): only the arena's members (and system jobs) read its
// graph and nightly rows, another org cannot write into it, the schedule follows the project's time
// zone, and the scheduler credential sees the schedule (ids, zone, day) and nothing else.

const enabled = await integrationEnabled();
const SCHEDULER = createHash('sha256').update('memory-scheduler').digest('hex');

describe.skipIf(!enabled)('arena memory (kg_nodes, state_days, memory_schedule)', () => {
  let t: TestDatabase;
  let a: TenantFixture;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'memory');
    await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
      await sql`
        INSERT INTO kg_nodes (org_id, project_id, type, key, title, first_seen_day, last_seen_day)
        VALUES (${a.orgId}, ${a.projectId}, 'Decision', 'D-001', 'Use Postgres', '2026-11-01',
                '2026-11-01')`.execute(tx);
      await sql`
        INSERT INTO state_days (org_id, project_id, day, status, title, chapter)
        VALUES (${a.orgId}, ${a.projectId}, '2026-11-01', 'done', 'A start', 'canary-chapter')`.execute(
        tx,
      );
    });
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const count = (table: 'kg_nodes' | 'state_days', userId: string) =>
    t.db.withTenant({ orgId: a.orgId, userId }, async (tx) => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE project_id = ${a.projectId}`.execute(
        tx,
      );
      return rows[0]!.n;
    });

  it('members read the memory; a non-member of the same org reads none', async () => {
    expect(await count('kg_nodes', a.users.member)).toBe(1);
    expect(await count('state_days', a.users.member)).toBe(1);
    expect(await count('kg_nodes', a.users.outsider)).toBe(0);
    expect(await count('state_days', a.users.outsider)).toBe(0);
  });

  it('another org cannot write into the arena memory', async () => {
    const b = await createTenantFixture(t.db, 'memory-b');
    await expect(
      t.db.withTenant({ orgId: b.orgId, userId: b.users.owner }, (tx) =>
        sql`
          INSERT INTO kg_nodes (org_id, project_id, type, key, title, first_seen_day, last_seen_day)
          VALUES (${a.orgId}, ${a.projectId}, 'Decision', 'D-999', 'Injected', '2026-11-01',
                  '2026-11-01')`.execute(tx),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the schedule follows the project zone and the scheduler sees only the schedule', async () => {
    await t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
      sql`UPDATE projects SET timezone = 'Asia/Kolkata' WHERE id = ${a.projectId}`.execute(tx),
    );
    const seen = await t.db.withCredential({ credential: SCHEDULER }, async (tx) => {
      const schedule = await sql<{ timezone: string }>`
        SELECT timezone FROM memory_schedule WHERE project_id = ${a.projectId}`.execute(tx);
      const nodes = await sql<{ n: number }>`SELECT count(*)::int AS n FROM kg_nodes`.execute(tx);
      const days = await sql<{ n: number }>`SELECT count(*)::int AS n FROM state_days`.execute(tx);
      return { schedule: schedule.rows, nodes: nodes.rows[0]!.n, days: days.rows[0]!.n };
    });
    expect(seen.schedule).toEqual([{ timezone: 'Asia/Kolkata' }]);
    expect(seen.nodes).toBe(0);
    expect(seen.days).toBe(0);
  });

  it('a done chapter is never rewritten by a later upsert', async () => {
    await t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
      sql`
        INSERT INTO state_days (org_id, project_id, day, status, chapter)
        VALUES (${a.orgId}, ${a.projectId}, '2026-11-01', 'failed', 'rewritten')
        ON CONFLICT (project_id, day) DO UPDATE SET chapter = EXCLUDED.chapter
         WHERE state_days.status NOT IN ('done', 'quiet')`.execute(tx),
    );
    const chapter = await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
      const { rows } = await sql<{ chapter: string }>`
        SELECT chapter FROM state_days WHERE project_id = ${a.projectId}`.execute(tx);
      return rows[0]!.chapter;
    });
    expect(chapter).toBe('canary-chapter');
  });
});
