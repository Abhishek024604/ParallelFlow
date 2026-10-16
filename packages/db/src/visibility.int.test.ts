import { sql, type RawBuilder } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from './database.js';
import { createTestDatabase, integrationEnabled, type TestDatabase } from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// Inside one org: the RESTRICTIVE policies from schema_v2 (doc 06 §6.3). Arena content is for project
// members only, DMs are participant-only, and posting needs arena.post. Private belongs to no org
// (ADR-034): no tenant context sees it, not even the owner's; only the owner's user scope does.

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
    it('owner sees the arena and their DM; Private chats and files are not in the org', async () => {
      expect(await visible('owner')).toEqual({
        arenaMessages: 1,
        privateSessions: 0,
        privateMessages: 0,
        privateArtifacts: 0,
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
      // Arena + DM. The private message has no org, so no system job sees it.
      expect(all).toBe(2);
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

  describe('Private in user scope (ADR-034)', () => {
    const mine = (who: Who) =>
      t.db.withUser({ userId: f.users[who] }, async (tx) => ({
        privateSessions: await n(tx, sql`SELECT count(*)::int AS n FROM private_sessions`),
        privateMessages: await n(
          tx,
          sql`SELECT count(*)::int AS n FROM messages WHERE private_session_id IS NOT NULL`,
        ),
        privateProjects: await n(tx, sql`SELECT count(*)::int AS n FROM private_projects`),
        personalAgents: await n(tx, sql`SELECT count(*)::int AS n FROM agents`),
        turns: await n(tx, sql`SELECT count(*)::int AS n FROM runtime_turns`),
        toolCalls: await n(tx, sql`SELECT count(*)::int AS n FROM app_tool_calls`),
        // 0007: private files (artifact, version, in-database blob).
        artifacts: await n(tx, sql`SELECT count(*)::int AS n FROM artifacts`),
        versions: await n(tx, sql`SELECT count(*)::int AS n FROM artifact_versions`),
        blobs: await n(tx, sql`SELECT count(*)::int AS n FROM blobs`),
      }));

    it('the owner sees their whole Private space', async () => {
      expect(await mine('owner')).toEqual({
        privateSessions: 1,
        privateMessages: 1,
        privateProjects: 1,
        personalAgents: 1,
        turns: 1,
        toolCalls: 1,
        artifacts: 1,
        versions: 1,
        blobs: 1,
      });
    });

    it.each(['member', 'observer', 'outsider'] as const)('%s sees none of it', async (who) => {
      expect(await mine(who)).toEqual({
        privateSessions: 0,
        privateMessages: 0,
        privateProjects: 0,
        personalAgents: 0,
        turns: 0,
        toolCalls: 0,
        artifacts: 0,
        versions: 0,
        blobs: 0,
      });
    });

    it("nobody can write into someone else's private chat", async () => {
      const outcome = await t.db
        .withUser({ userId: f.users.member }, (tx) =>
          sql`INSERT INTO messages (org_id, private_session_id, author_type, author_id, body)
              VALUES (NULL, ${f.privateSessionId}, 'user', ${f.users.member}, 'x')`.execute(tx),
        )
        .then(
          () => 'posted',
          (err: { code?: string }) => err.code,
        );
      expect(outcome).toBe('42501');
    });

    it('a private artifact with an org is rejected by the CHECK, even from a system job', async () => {
      const outcome = await t.db
        .withSystemJob({ orgId: f.orgId }, (tx) =>
          sql`INSERT INTO artifacts (org_id, lineage_id, scope, kind, name, owner_user_id, created_by_type, created_by)
            VALUES (${f.orgId}, gen_random_uuid(), 'private', 'document', 'x', ${f.users.owner}, 'user', ${f.users.owner})`.execute(
            tx,
          ),
        )
        .then(
          () => 'inserted',
          (err: { code?: string }) => err.code,
        );
      expect(outcome).toBe('23514');
    });

    it("nobody can add a file to someone else's Private space", async () => {
      const outcome = await t.db
        .withUser({ userId: f.users.member }, (tx) =>
          sql`INSERT INTO blobs (org_id, owner_user_id, sha256, size_bytes, content)
              VALUES (NULL, ${f.users.owner}, 'x', 1, '\\x00'::bytea)`.execute(tx),
        )
        .then(
          () => 'inserted',
          (err: { code?: string }) => err.code,
        );
      expect(outcome).toBe('42501');
    });

    it('a private message with an org is rejected by the CHECK, even from a system job', async () => {
      const outcome = await t.db
        .withSystemJob({ orgId: f.orgId }, (tx) =>
          sql`INSERT INTO messages (org_id, private_session_id, author_type, author_id, body)
            VALUES (${f.orgId}, ${f.privateSessionId}, 'user', ${f.users.owner}, 'x')`.execute(tx),
        )
        .then(
          () => 'posted',
          (err: { code?: string }) => err.code,
        );
      expect(outcome).toBe('23514');
    });
  });

  describe('private session binds once', () => {
    it('can bind to a project once and never rebind', async () => {
      const bind = (projectId: string | null) =>
        t.db
          .withUser({ userId: f.users.owner }, (tx) =>
            sql`UPDATE private_sessions
              SET bound_project_id = ${projectId},
                  bound_at = CASE WHEN ${projectId}::uuid IS NULL THEN NULL ELSE now() END
              WHERE id = ${f.privateSessionId}`.execute(tx),
          )
          .then(
            (r) => `updated ${r.numAffectedRows}`,
            (err: { code?: string }) => err.code,
          );

      expect(await bind(f.projectId)).toBe('updated 1');
      expect(await bind(null)).toBe('23514');
    });
  });
});
