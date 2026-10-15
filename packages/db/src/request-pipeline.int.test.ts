import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from './database.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// F21-04 (migration 0004): idempotency_keys is owner-only; rate_limit_counters lets a user touch only
// their own counter and their current org's counter.

const enabled = await integrationEnabled();

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const insertKey = (tx: Tx, userId: string, key: string) =>
  sql`INSERT INTO idempotency_keys (user_id, key, method, path, request_hash, response_status,
        response_body, expires_at)
      VALUES (${userId}, ${key}, 'POST', '/v1/x', 'h', 201, '{"secret":"s"}', now() + interval '1 day')`.execute(
    tx,
  );

const countKeys = async (tx: Tx) =>
  (await sql<{ n: number }>`SELECT count(*)::int AS n FROM idempotency_keys`.execute(tx)).rows[0]!
    .n;

const hit = (tx: Tx, bucket: string, subject: string) =>
  sql`INSERT INTO rate_limit_counters (bucket, subject_id, window_start, hits)
      VALUES (${bucket}, ${subject}, date_trunc('minute', now()), 1)
      ON CONFLICT (bucket, subject_id, window_start) DO UPDATE SET hits = rate_limit_counters.hits + 1`.execute(
    tx,
  );

describe.skipIf(!enabled)('request pipeline tables (RLS)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    await t.db.withUser({ userId: a.users.owner }, (tx) => insertKey(tx, a.users.owner, 'k-a'));
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('idempotency_keys', () => {
    it('the owner reads their own record in user scope and in a tenant context', async () => {
      expect(await t.db.withUser({ userId: a.users.owner }, countKeys)).toBe(1);
      expect(
        await t.db.withProjectMember({ userId: a.users.owner, projectId: a.projectId }, countKeys),
      ).toBe(1);
    });

    it('another user, even in the same org, sees and changes nothing', async () => {
      expect(await t.db.withUser({ userId: a.users.member }, countKeys)).toBe(0);
      const touched = await t.db.withTenant(
        { orgId: a.orgId, userId: a.users.member },
        async (tx) => {
          const u = await sql`UPDATE idempotency_keys SET response_body = 'x'`.execute(tx);
          const d = await sql`DELETE FROM idempotency_keys`.execute(tx);
          return (u.numAffectedRows ?? 0n) + (d.numAffectedRows ?? 0n);
        },
      );
      expect(touched).toBe(0n);
    });

    it('nobody can write a record for someone else', async () => {
      expect(
        await code(
          t.db.withUser({ userId: a.users.member }, (tx) => insertKey(tx, a.users.owner, 'forged')),
        ),
      ).toBe('42501');
    });

    it('system jobs, identity scope and a bare connection see nothing', async () => {
      expect(await t.db.withSystemJob({ orgId: a.orgId }, countKeys)).toBe(0);
      expect(await t.db.withIdentity({ email: a.emails.owner }, countKeys)).toBe(0);
      const client = new pg.Client({ connectionString: t.appUrl });
      await client.connect();
      try {
        const { rows } = await client.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM saras.idempotency_keys',
        );
        expect(rows[0]!.n).toBe(0);
      } finally {
        await client.end();
      }
    });
  });

  describe('rate_limit_counters', () => {
    it('a user counts against their own bucket, and the org bucket only inside that org', async () => {
      expect(
        await code(
          t.db.withUser({ userId: a.users.member }, (tx) => hit(tx, 'user', a.users.member)),
        ),
      ).toBe('ok');
      expect(
        await code(
          t.db.withOrgMember({ userId: a.users.member, orgId: a.orgId }, (tx) =>
            hit(tx, 'org', a.orgId),
          ),
        ),
      ).toBe('ok');
    });

    it("cannot touch another user's or another org's counter", async () => {
      const denied = [
        await code(
          t.db.withUser({ userId: a.users.member }, (tx) => hit(tx, 'user', a.users.owner)),
        ),
        // User scope has the nil org: no org bucket at all.
        await code(t.db.withUser({ userId: a.users.member }, (tx) => hit(tx, 'org', a.orgId))),
        await code(
          t.db.withOrgMember({ userId: a.users.member, orgId: a.orgId }, (tx) =>
            hit(tx, 'org', b.orgId),
          ),
        ),
      ];
      expect(denied).toEqual(['42501', '42501', '42501']);
    });

    it('reads only own counters', async () => {
      const seen = await t.db.withOrgMember(
        { userId: a.users.owner, orgId: a.orgId },
        async (tx) => {
          const { rows } = await sql<{
            bucket: string;
            subject_id: string;
          }>`SELECT bucket, subject_id FROM rate_limit_counters`.execute(tx);
          return rows;
        },
      );
      // a.owner has no user counter yet; the org counter of org A is shared by its members.
      expect(seen).toEqual([{ bucket: 'org', subject_id: a.orgId }]);
      const other = await t.db.withUser({ userId: randomUUID() }, (tx) =>
        sql`SELECT 1 FROM rate_limit_counters`.execute(tx),
      );
      expect(other.rows).toEqual([]);
    });
  });
});
