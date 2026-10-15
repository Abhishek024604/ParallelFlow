import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from './database.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// Inside one org: the RESTRICTIVE policies from schema_v2 (doc 06 §6.3). Arena content is for project
// members only, Private is owner-only, DMs are participant-only, and posting needs arena.post.

const enabled = await integrationEnabled();

type Who = keyof TenantFixture['users'];

async function n(tx: Tx, query: RawBuilder<{ n: number }>): Promise<number> {
  return (await query.execute(tx)).rows[0]!.n;
}

describe.skipIf(!enabled)('visibility inside an org (RLS)', () => {
  let t: TestDatabase;
  let f: TenantFixture;

  const asUser = <T>(who: Who, fn: (tx: Tx) => Promise<T>) =>
    t.db.withTenant({ orgId: f.orgId, userId: f.users[who] }, fn);

  const visible = (who: Who) =>
    asUser(who, async (tx) => ({
      arenaMessages: await n(
        tx,
        sql`SELECT count(*)::int AS n FROM messages WHERE arena_id = ${f.arenaId}`,
      ),
      privateSessions: await n(tx, sql`SELECT count(*)::int AS n FROM private_sessions`),
      privateMessages: await n(
        tx,
        sql`SELECT count(*)::int AS n FROM messages WHERE private_session_id IS NOT NULL`,
      ),
      privateArtifacts: await n(
        tx,
        sql`SELECT count(*)::int AS n FROM artifacts WHERE scope = 'private'`,
      ),
      dmMessages: await n(
        tx,
        sql`SELECT count(*)::int AS n FROM messages WHERE dm_thread_id = ${f.dmThreadId}`,
      ),
    }));

  const post = (who: Who) =>
    asUser(who, (tx) =>
      sql`INSERT INTO messages (org_id, arena_id, author_type, author_id, body)
          VALUES (${f.orgId}, ${f.arenaId}, 'user', ${f.users[who]}, 'hi')`.execute(tx),
    ).then(
      () => 'posted',
      (err: { code?: string }) => err.code,
    );

  beforeAll(async () => {
    t = await createTestDatabase();
    f = await createTenantFixture(t.db, 'v');
  });

  afterAll(async () => {
    await t?.cleanup();
  });

  describe('reads', () => {
    it('owner sees the arena, their own private space and their DM', async () => {
      expect(await visible('owner')).toEqual({
        arenaMessages: 1,
        privateSessions: 1,
        privateMessages: 1,
        privateArtifacts: 1,
        dmMessages: 1,
      });
    });

    it("member sees the arena and their DM, but not the owner's private space", async () => {
      expect(await visible('member')).toEqual({
        arenaMessages: 1,
        privateSessions: 0,
        privateMessages: 0,
        privateArtifacts: 0,
        dmMessages: 1,
      });
    });

    it('observer sees the arena only', async () => {
      expect(await visible('observer')).toEqual({
        arenaMessages: 1,
        privateSessions: 0,
        privateMessages: 0,
        privateArtifacts: 0,
        dmMessages: 0,
      });
    });

    it('an org member who is not a project member (even a unit lead) sees no arena content', async () => {
      expect(await visible('outsider')).toEqual({
        arenaMessages: 0,
        privateSessions: 0,
        privateMessages: 0,
        privateArtifacts: 0,
        dmMessages: 0,
      });
    });

    it('a system job sees everything in its org', async () => {
      const all = await t.db.withSystemJob({ orgId: f.orgId }, (tx) =>
        n(tx, sql`SELECT count(*)::int AS n FROM messages`),
      );
      expect(all).toBe(3);
    });
  });

  describe('arena writes need arena.post', () => {
    it.each([
      ['owner', 'posted'],
      ['member', 'posted'],
      ['observer', '42501'],
      ['outsider', '42501'],
    ] as const)('%s → %s', async (who, outcome) => {
      expect(await post(who)).toBe(outcome);
    });
  });

  describe('private session binds once', () => {
    it('can bind to a project once and never rebind', async () => {
      const bind = (projectId: string | null) =>
        asUser('owner', (tx) =>
          sql`UPDATE private_sessions
              SET bound_project_id = ${projectId},
                  bound_at = CASE WHEN ${projectId}::uuid IS NULL THEN NULL ELSE now() END
              WHERE id = ${f.privateSessionId}`.execute(tx),
        ).then(
          (r) => `updated ${r.numAffectedRows}`,
          (err: { code?: string }) => err.code,
        );

      expect(await bind(f.projectId)).toBe('updated 1');
      expect(await bind(null)).toBe('23514');
    });
  });
});
