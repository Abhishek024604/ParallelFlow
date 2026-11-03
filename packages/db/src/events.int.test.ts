import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordArenaEvent } from './events.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// The arena event stream (ADR-044, migration 0016): the database chains each arena's rows, only the
// arena's members (and system jobs) read them, and they stay append-only.

const enabled = await integrationEnabled();

describe.skipIf(!enabled)('arena events (audit_events)', () => {
  let t: TestDatabase;
  let a: TenantFixture;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'events');
  });
  afterAll(async () => {
    await t?.cleanup();
  });

  const scope = () => ({ orgId: a.orgId, projectId: a.projectId });

  it('chains each arena row to the previous one: sha256(prev_hash || canonical row)', async () => {
    await t.db.withTenant({ orgId: a.orgId, userId: a.users.owner }, async (tx) => {
      for (const name of ['one.md', 'two.md', 'three.md']) {
        await recordArenaEvent(
          tx,
          scope(),
          { type: 'user', id: a.users.owner },
          {
            action: 'file.created',
            target: { type: 'file', id: name },
            metadata: { name, version: 1 },
          },
        );
      }
    });
    const rows = await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
      const { rows } = await sql<{
        id: string;
        prev_hash: Buffer | null;
        hash: Buffer;
        canonical: string;
      }>`
        SELECT e.id::text AS id, e.prev_hash, e.hash, saras.audit_event_canonical(e) AS canonical
          FROM audit_events e WHERE e.project_id = ${a.projectId} ORDER BY e.id`.execute(tx);
      return rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]!;
      const prev = i === 0 ? null : rows[i - 1]!.hash;
      if (i > 0) expect(row.prev_hash?.equals(prev!)).toBe(true);
      const expected = createHash('sha256')
        .update(Buffer.concat([prev ?? Buffer.alloc(0), Buffer.from(row.canonical, 'utf8')]))
        .digest();
      expect(row.hash.equals(expected)).toBe(true);
    }
  });

  it('members read their arena events; a non-member of the same org reads none', async () => {
    const asMember = await t.db.withTenant({ orgId: a.orgId, userId: a.users.member }, (tx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events
                          WHERE project_id = ${a.projectId}`.execute(tx),
    );
    expect(asMember.rows[0]!.n).toBeGreaterThan(0);
    const asOutsider = await t.db.withTenant({ orgId: a.orgId, userId: a.users.outsider }, (tx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_events
                          WHERE project_id = ${a.projectId}`.execute(tx),
    );
    expect(asOutsider.rows[0]!.n).toBe(0);
  });

  it('another org cannot write into the arena, and events cannot change', async () => {
    const b = await createTenantFixture(t.db, 'events-b');
    await expect(
      t.db.withTenant({ orgId: b.orgId, userId: b.users.owner }, (tx) =>
        recordArenaEvent(
          tx,
          scope(),
          { type: 'user', id: b.users.owner },
          {
            action: 'file.deleted',
            target: { type: 'file', id: 'x' },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
        sql`UPDATE audit_events SET action = 'x' WHERE project_id = ${a.projectId}`.execute(tx),
      ),
    ).rejects.toThrow(/append-only/);
  });
});
