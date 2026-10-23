import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  ArenaMessagePage,
  CreateArenaResponse,
  ProjectMemberList,
  SendArenaMessageResult,
} from '@parallelflow/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@parallelflow/db/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// Arena chat smoke test (build step 3): post, list, poll with `after`, non-member 404, and an
// Observer without arena.post → 403. Real Nest app and database (RLS on); sessions are faked with
// `Authorization: Bearer <user id>` as in arenas.int.test.ts.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('arena chat: messages and members', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const riya = { id: randomUUID(), name: 'Riya Sharma' };
  const olu = { id: randomUUID(), name: 'Olu Observer' };
  const stranger = { id: randomUUID(), name: 'Sam Stranger' };

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const messagesPath = () => `/v1/projects/${projectId}/arena/messages`;
  const post = (user: { id: string }, body: unknown) =>
    request(app.getHttpServer())
      .post(messagesPath())
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID())
      .send(body as object);
  const list = (user: { id: string }, q: Record<string, string> = {}) =>
    request(app.getHttpServer()).get(messagesPath()).query(q).set('Authorization', as(user));

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, riya, olu, stranger]) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, `${u.id.slice(0, 8)}@adva.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });

    const created = await request(app.getHttpServer())
      .post('/v1/arenas')
      .set('Authorization', as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'Interview Prep' });
    expect(created.status).toBe(201);
    projectId = (created.body as CreateArenaResponse).id;

    // Riya as a Member, Olu as an Observer (arena.read only). Fixture rows, written as the owner.
    const { rows } = await query<{ org_id: string; member_role: string }>(
      t.ownerUrl,
      `SELECT org_id, id AS member_role FROM saras.project_roles WHERE project_id = $1 AND key = 'member'`,
      [projectId],
    );
    const { org_id: org, member_role: memberRole } = rows[0]!;
    const observerRole = randomUUID();
    await query(
      t.ownerUrl,
      `INSERT INTO saras.project_roles (id, org_id, project_id, key, name) VALUES ($1, $2, $3, 'observer', 'Observer')`,
      [observerRole, org, projectId],
    );
    await query(
      t.ownerUrl,
      `INSERT INTO saras.role_capabilities (org_id, role_id, capability) VALUES ($1, $2, 'arena.read')`,
      [org, observerRole],
    );
    for (const [user, role] of [
      [riya, memberRole],
      [olu, observerRole],
    ] as const) {
      await query(
        t.ownerUrl,
        `INSERT INTO saras.org_memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`,
        [org, user.id],
      );
      await query(
        t.ownerUrl,
        'INSERT INTO saras.project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)',
        [org, projectId, user.id],
      );
      await query(
        t.ownerUrl,
        'INSERT INTO saras.project_member_roles (org_id, project_id, user_id, role_id) VALUES ($1, $2, $3, $4)',
        [org, projectId, user.id, role],
      );
    }
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('posts, lists, polls with after, and keeps non-members and observers out', async () => {
    // Empty arena: no messages, nothing to poll from yet.
    const empty = await list(riya);
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ items: [], next_cursor: null, latest_cursor: null });

    // A member posts → 201 with the message.
    const first = await post(riya, { body: '  Hello team\nfirst line  ' });
    expect(first.status).toBe(201);
    const posted = (first.body as SendArenaMessageResult).message;
    expect(posted).toMatchObject({
      body: 'Hello team\nfirst line',
      parent_id: null,
      kind: 'text',
      author: { type: 'user', id: riya.id, display_name: 'Riya Sharma', initials: 'RS' },
    });
    expect(posted.author.roles).toEqual(['Member']);

    // Another member lists → sees it.
    const seen = await list(owner);
    expect(seen.status).toBe(200);
    const page = seen.body as ArenaMessagePage;
    expect(page.items.map((m) => m.id)).toEqual([posted.id]);
    expect(page.latest_cursor).toEqual(expect.any(String));

    // Polling with `after` returns only newer messages (a reply, in order), then nothing.
    const reply = await post(owner, { body: 'Welcome!', parent_id: posted.id });
    expect(reply.status).toBe(201);
    const second = await post(riya, { body: 'Thanks' });
    expect(second.status).toBe(201);
    const polled = await list(riya, { after: page.latest_cursor! });
    expect(polled.status).toBe(200);
    const newer = polled.body as ArenaMessagePage;
    expect(newer.items.map((m) => m.body)).toEqual(['Welcome!', 'Thanks']);
    expect(newer.items[0]).toMatchObject({ parent_id: posted.id, author: { roles: ['Owner'] } });
    const idle = await list(riya, { after: newer.latest_cursor! });
    expect((idle.body as ArenaMessagePage).items).toEqual([]);
    expect((idle.body as ArenaMessagePage).latest_cursor).toBe(newer.latest_cursor);

    // A bad cursor is a 400, not a 500.
    expect((await list(riya, { after: 'not-a-cursor' })).status).toBe(400);

    // Non-member → 404 on read, post and members.
    expect((await list(stranger)).status).toBe(404);
    expect((await post(stranger, { body: 'hi' })).status).toBe(404);
    const strangerMembers = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/members`)
      .set('Authorization', as(stranger));
    expect(strangerMembers.status).toBe(404);

    // Observer (no arena.post) can read but posting → 403 with the required permission.
    expect((await list(olu)).status).toBe(200);
    const denied = await post(olu, { body: 'can I?' });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({
      code: 'FORBIDDEN',
      required_permission: 'cap arena.post',
    });

    // Members panel: everyone with roles, the owner first; can_post per viewer.
    const members = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/members`)
      .set('Authorization', as(olu));
    expect(members.status).toBe(200);
    const memberList = members.body as ProjectMemberList;
    expect(memberList.viewer).toEqual({ user_id: olu.id, can_post: false });
    expect(memberList.items[0]).toMatchObject({ user_id: owner.id, is_owner: true });
    expect(memberList.items.map((m) => m.roles.map((r) => r.name))).toEqual([
      ['Owner'],
      ['Member'],
      ['Observer'],
    ]);
  });
});
