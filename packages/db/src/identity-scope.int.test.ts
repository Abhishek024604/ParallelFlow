import { randomUUID } from 'node:crypto';
import { sql, type RawBuilder } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NotVisibleError, type Tx } from './database.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// ADR-031: RLS on users / organizations, the user and identity scopes, and the verified entry points
// (withOrgMember, withProjectMember) that derive the tenant from an active membership.

const enabled = await integrationEnabled();

async function n(tx: Tx, query: RawBuilder<{ n: number }>): Promise<number> {
  return (await query.execute(tx)).rows[0]!.n;
}

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (err) {
    if (err instanceof NotVisibleError) return 'NOT_VISIBLE';
    return (err as { code?: string }).code ?? String(err);
  }
}

describe.skipIf(!enabled)('identity tables and user scope (ADR-031)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  /** a.owner is also a plain member of org B and of B's project. */
  let both: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    both = a.users.owner;
    await t.db.withSystemJob({ orgId: b.orgId }, async (tx) => {
      await sql`INSERT INTO org_memberships (org_id, user_id) VALUES (${b.orgId}, ${both})`.execute(
        tx,
      );
      await sql`INSERT INTO project_members (org_id, project_id, user_id)
                VALUES (${b.orgId}, ${b.projectId}, ${both})`.execute(tx);
    });
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('no context', () => {
    it('reads no users and no organizations', async () => {
      const client = new pg.Client({ connectionString: t.appUrl });
      await client.connect();
      try {
        for (const table of ['users', 'organizations']) {
          const { rows } = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM saras.${table}`,
          );
          expect(rows[0]!.n, table).toBe(0);
        }
      } finally {
        await client.end();
      }
    });
  });

  describe('user scope (withUser)', () => {
    const mine = <T>(fn: (tx: Tx) => Promise<T>) => t.db.withUser({ userId: both }, fn);

    it('sees only yourself in users', async () => {
      const ids = await mine(async (tx) =>
        (await sql<{ id: string }>`SELECT id FROM users`.execute(tx)).rows.map((r) => r.id),
      );
      expect(ids).toEqual([both]);
    });

    it('lists your orgs, memberships and projects across arenas', async () => {
      const seen = await mine(async (tx) => ({
        orgs: await n(tx, sql`SELECT count(*)::int AS n FROM organizations`),
        orgMemberships: await n(tx, sql`SELECT count(*)::int AS n FROM org_memberships`),
        foreignMemberships: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM org_memberships WHERE user_id <> ${both}`,
        ),
        projectMemberships: await n(tx, sql`SELECT count(*)::int AS n FROM project_members`),
        projects: await n(tx, sql`SELECT count(*)::int AS n FROM projects`),
      }));
      expect(seen).toEqual({
        orgs: 2,
        orgMemberships: 2,
        foreignMemberships: 0,
        projectMemberships: 2,
        projects: 2,
      });
    });

    it('sees no tenant content', async () => {
      const seen = await mine(async (tx) => ({
        arenas: await n(tx, sql`SELECT count(*)::int AS n FROM arenas`),
        messages: await n(tx, sql`SELECT count(*)::int AS n FROM messages`),
        privateSessions: await n(tx, sql`SELECT count(*)::int AS n FROM private_sessions`),
        tasks: await n(tx, sql`SELECT count(*)::int AS n FROM tasks`),
      }));
      expect(seen).toEqual({ arenas: 0, messages: 0, privateSessions: 0, tasks: 0 });
    });

    it('cannot write: joining an org or renaming a project is rejected', async () => {
      expect(
        await code(
          mine((tx) =>
            sql`INSERT INTO project_members (org_id, project_id, user_id)
                VALUES (${a.orgId}, ${a.projectId}, ${a.users.outsider})`.execute(tx),
          ),
        ),
      ).toBe('42501');
      const renamed = await mine((tx) =>
        sql`UPDATE projects SET name = 'x' WHERE id = ${a.projectId}`.execute(tx),
      );
      expect(renamed.numAffectedRows).toBe(0n);
    });

    it('hides orgs and projects where your membership is suspended', async () => {
      const setStatus = (status: string) =>
        t.db.withSystemJob({ orgId: b.orgId }, (tx) =>
          sql`UPDATE org_memberships SET status = ${status}
              WHERE org_id = ${b.orgId} AND user_id = ${both}`.execute(tx),
        );
      await setStatus('suspended');
      try {
        const seen = await mine(async (tx) => ({
          orgs: await n(tx, sql`SELECT count(*)::int AS n FROM organizations`),
          projects: await n(tx, sql`SELECT count(*)::int AS n FROM projects`),
        }));
        expect(seen).toEqual({ orgs: 1, projects: 1 });
      } finally {
        await setStatus('active');
      }
    });
  });

  describe('tenant context stays single-org', () => {
    it('shows co-members of the current org only, and none of your rows in other orgs', async () => {
      const seen = await t.db.withTenant({ orgId: a.orgId, userId: both }, async (tx) => ({
        users: await n(tx, sql`SELECT count(*)::int AS n FROM users`),
        foreignUsers: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM users WHERE id IN (${b.users.owner}, ${b.users.member})`,
        ),
        orgs: await n(tx, sql`SELECT count(*)::int AS n FROM organizations`),
        otherOrgMemberships: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM org_memberships WHERE org_id = ${b.orgId}`,
        ),
        otherProjects: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM projects WHERE org_id = ${b.orgId}`,
        ),
      }));
      expect(seen).toEqual({
        users: 4,
        foreignUsers: 0,
        orgs: 1,
        otherOrgMemberships: 0,
        otherProjects: 0,
      });
    });

    it('lets you edit yourself but not a co-member', async () => {
      const asMember = (fn: (tx: Tx) => Promise<{ numAffectedRows?: bigint }>) =>
        t.db.withTenant({ orgId: a.orgId, userId: a.users.member }, fn);
      const self = await asMember((tx) =>
        sql`UPDATE users SET display_name = 'Me' WHERE id = ${a.users.member}`.execute(tx),
      );
      const other = await asMember((tx) =>
        sql`UPDATE users SET display_name = 'Pwned' WHERE id = ${a.users.owner}`.execute(tx),
      );
      expect([self.numAffectedRows, other.numAffectedRows]).toEqual([1n, 0n]);
    });

    it('cannot create or rename another org', async () => {
      const asOwner = <T>(fn: (tx: Tx) => Promise<T>) =>
        t.db.withTenant({ orgId: a.orgId, userId: a.users.owner }, fn);
      expect(
        await code(
          asOwner((tx) =>
            sql`INSERT INTO organizations (id, slug, name) VALUES (${randomUUID()}, ${`x-${randomUUID()}`}, 'x')`.execute(
              tx,
            ),
          ),
        ),
      ).toBe('42501');
      const renamed = await asOwner((tx) =>
        sql`UPDATE organizations SET name = 'x' WHERE id = ${b.orgId}`.execute(tx),
      );
      expect(renamed.numAffectedRows).toBe(0n);
    });
  });

  describe('identity scope (withIdentity)', () => {
    it('finds only the account of the verified email', async () => {
      const seen = await t.db.withIdentity({ email: a.emails.owner.toUpperCase() }, async (tx) => ({
        all: (await sql<{ id: string }>`SELECT id FROM users`.execute(tx)).rows.map((r) => r.id),
        other: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM users WHERE email = ${a.emails.member}`,
        ),
        orgs: await n(tx, sql`SELECT count(*)::int AS n FROM organizations`),
        memberships: await n(tx, sql`SELECT count(*)::int AS n FROM org_memberships`),
      }));
      expect(seen).toEqual({ all: [a.users.owner], other: 0, orgs: 0, memberships: 0 });
    });

    it('can create the account for its own email only', async () => {
      const email = `new-${randomUUID()}@signup.test`;
      const insert = (address: string) =>
        code(
          t.db.withIdentity({ email }, (tx) =>
            sql`INSERT INTO users (id, email, display_name, handle)
                VALUES (${randomUUID()}, ${address}, 'New', ${`h-${randomUUID()}`})`.execute(tx),
          ),
        );
      expect(await insert(email)).toBe('ok');
      expect(await insert(`someone-else-${randomUUID()}@signup.test`)).toBe('42501');
    });

    it('cannot modify another account', async () => {
      const result = await t.db.withIdentity({ email: a.emails.member }, (tx) =>
        sql`UPDATE users SET email = 'hijack@evil.test' WHERE id = ${a.users.owner}`.execute(tx),
      );
      expect(result.numAffectedRows).toBe(0n);
    });
  });

  describe('verified entry points', () => {
    const project = (userId: string, projectId: string) =>
      code(
        t.db.withProjectMember({ userId, projectId }, async (tx, m) => {
          expect(m.orgId).toBeDefined();
          return n(tx, sql`SELECT count(*)::int AS n FROM messages WHERE arena_id IS NOT NULL`);
        }),
      );

    it('a project member gets the tenant context of the project org', async () => {
      const result = await t.db.withProjectMember(
        { userId: a.users.member, projectId: a.projectId },
        async (tx, m) => ({
          orgId: m.orgId,
          arenaMessages: await n(
            tx,
            sql`SELECT count(*)::int AS n FROM messages WHERE arena_id = ${a.arenaId}`,
          ),
        }),
      );
      expect(result.orgId).toBe(a.orgId);
      expect(result.arenaMessages).toBeGreaterThan(0);
    });

    it('a user in two arenas gets each project in its own org', async () => {
      const orgs = await Promise.all(
        [a.projectId, b.projectId].map((projectId) =>
          t.db.withProjectMember({ userId: both, projectId }, async (_tx, m) => m.orgId),
        ),
      );
      expect(orgs).toEqual([a.orgId, b.orgId]);
    });

    it.each([
      ['org member who is not a project member', () => a.users.outsider, () => a.projectId],
      ['member of another org', () => b.users.owner, () => a.projectId],
      ['unknown project', () => a.users.owner, () => randomUUID()],
    ])('denies %s (404, not 403)', async (_label, user, projectId) => {
      expect(await project(user(), projectId())).toBe('NOT_VISIBLE');
    });

    it('denies a suspended member and an expired guest', async () => {
      await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
        await sql`UPDATE org_memberships SET status = 'suspended'
                  WHERE org_id = ${a.orgId} AND user_id = ${a.users.member}`.execute(tx);
        await sql`UPDATE org_memberships SET role = 'guest', expires_at = now() - interval '1 day'
                  WHERE org_id = ${a.orgId} AND user_id = ${a.users.observer}`.execute(tx);
      });
      try {
        expect(await project(a.users.member, a.projectId)).toBe('NOT_VISIBLE');
        expect(await project(a.users.observer, a.projectId)).toBe('NOT_VISIBLE');
      } finally {
        await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
          await sql`UPDATE org_memberships SET status = 'active'
                    WHERE org_id = ${a.orgId} AND user_id = ${a.users.member}`.execute(tx);
          await sql`UPDATE org_memberships SET role = 'member', expires_at = NULL
                    WHERE org_id = ${a.orgId} AND user_id = ${a.users.observer}`.execute(tx);
        });
      }
    });

    it('withOrgMember admits org members and denies everyone else', async () => {
      const org = (userId: string, orgId: string) =>
        code(t.db.withOrgMember({ userId, orgId }, async (_tx, m) => m.orgId));
      expect(await org(a.users.outsider, a.orgId)).toBe('ok');
      expect(await org(b.users.owner, a.orgId)).toBe('NOT_VISIBLE');
      expect(await org(a.users.owner, randomUUID())).toBe('NOT_VISIBLE');
    });
  });
});
