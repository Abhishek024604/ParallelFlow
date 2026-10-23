import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  ChatMessagePage,
  CreateArenaResponse,
  PrivateChat,
  PrivateChatList,
  PrivateMessage,
  PrivateProject,
  PrivateProjectList,
  SendMessageResult,
} from '@parallelflow/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@parallelflow/db/testing';
import type { Request } from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// Private chats and projects smoke test (build step 5, ADR-034): the owner creates a chat and posts;
// anyone else gets 404; deleting a project moves its chat to Recent; no tenant context (of any org)
// sees a Private row. Real Nest app and database (RLS on); sessions faked as in messages.int.test.ts.
// No runtime is configured, so the AI turn fails with RUNTIME_NOT_CONFIGURED.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('private chats and projects', () => {
  let t: TestDatabase;
  let app: INestApplication;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const other = { id: randomUUID(), name: 'Riya Other' };
  let chat: PrivateChat;
  let project: PrivateProject;
  let orgId: string;

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const http = () => request(app.getHttpServer());
  const create = (user: { id: string }, path: string, body: object) =>
    http()
      .post(`/v1${path}`)
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const get = (user: { id: string }, path: string) =>
    http().get(`/v1${path}`).set('Authorization', as(user));

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, other]) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, `${u.id.slice(0, 8)}@priv.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });
    // An arena the owner is in, to prove its tenant context sees none of their Private rows.
    const arena = await create(owner, '/arenas', { name: 'Interview Prep' });
    expect(arena.status).toBe(201);
    const { rows } = await query<{ org_id: string }>(
      t.ownerUrl,
      'SELECT org_id FROM saras.projects WHERE id = $1',
      [(arena.body as CreateArenaResponse).id],
    );
    orgId = rows[0]!.org_id;
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('the owner creates a chat and posts; the first message names it', async () => {
    const created = await create(owner, '/private/sessions', {});
    expect(created.status).toBe(201);
    chat = created.body as PrivateChat;
    expect(chat).toMatchObject({ title: null, private_project_id: null, bound_project: null });

    const posted = await create(owner, `/private/sessions/${chat.id}/messages`, {
      body: 'Draft a launch plan',
    });
    expect(posted.status).toBe(201);
    const result = posted.body as SendMessageResult<PrivateMessage>;
    expect(result.message).toMatchObject({
      private_session_id: chat.id,
      body: 'Draft a launch plan',
      author: { type: 'user', id: owner.id, display_name: owner.name },
    });
    expect(result.turn?.status).toBe('queued');

    const page = await get(owner, `/private/sessions/${chat.id}/messages`);
    expect(page.status).toBe(200);
    expect((page.body as ChatMessagePage<PrivateMessage>).items.map((m) => m.body)).toContain(
      'Draft a launch plan',
    );

    const listed = await get(owner, '/private/sessions?q=launch');
    expect((listed.body as PrivateChatList).items).toMatchObject([
      { id: chat.id, title: 'Draft a launch plan' },
    ]);
    expect(
      ((await get(owner, '/private/sessions?q=nothing')).body as PrivateChatList).items,
    ).toEqual([]);
  });

  it('anyone else gets 404 on read and post, and an empty list', async () => {
    expect((await get(other, `/private/sessions/${chat.id}`)).status).toBe(404);
    expect((await get(other, `/private/sessions/${chat.id}/messages`)).status).toBe(404);
    expect(
      (await create(other, `/private/sessions/${chat.id}/messages`, { body: 'hi' })).status,
    ).toBe(404);
    const list = await get(other, '/private/sessions');
    expect(list.status).toBe(200);
    expect((list.body as PrivateChatList).items).toEqual([]);
    expect(
      (
        await http()
          .patch(`/v1/private/sessions/${chat.id}`)
          .set('Authorization', as(other))
          .send({ title: 'x' })
      ).status,
    ).toBe(404);
    expect(
      (await http().delete(`/v1/private/sessions/${chat.id}`).set('Authorization', as(other)))
        .status,
    ).toBe(404);
  });

  it('files the chat in a project; deleting the project moves it to Recent', async () => {
    const created = await create(owner, '/private/projects', { name: 'Ideas' });
    expect(created.status).toBe(201);
    project = created.body as PrivateProject;

    const moved = await http()
      .put(`/v1/private/sessions/${chat.id}/project`)
      .set('Authorization', as(owner))
      .send({ private_project_id: project.id });
    expect(moved.status).toBe(200);
    expect((moved.body as PrivateChat).private_project_id).toBe(project.id);
    expect(
      ((await get(owner, '/private/projects')).body as PrivateProjectList).items,
    ).toMatchObject([{ id: project.id, name: 'Ideas', chat_count: 1 }]);

    // Not theirs: 404 to rename or delete, and they cannot file their own chat in it.
    expect(
      (await http().delete(`/v1/private/projects/${project.id}`).set('Authorization', as(other)))
        .status,
    ).toBe(404);
    const theirs = (await create(other, '/private/sessions', {})).body as PrivateChat;
    expect(
      (
        await http()
          .put(`/v1/private/sessions/${theirs.id}/project`)
          .set('Authorization', as(other))
          .send({ private_project_id: project.id })
      ).status,
    ).toBe(400);

    const deleted = await http()
      .delete(`/v1/private/projects/${project.id}`)
      .set('Authorization', as(owner));
    expect(deleted.status).toBe(204);
    const after = (await get(owner, `/private/sessions/${chat.id}`)).body as PrivateChat;
    expect(after.private_project_id).toBeNull();
    expect(((await get(owner, '/private/projects')).body as PrivateProjectList).items).toEqual([]);
  });

  it('no tenant context sees a Private row, not even the owner in their own arena', async () => {
    const counts = await t.db.withTenant({ orgId, userId: owner.id }, async (tx) => {
      const n = async (table: string) =>
        (
          await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)}
                                    WHERE org_id IS NULL`.execute(tx)
        ).rows[0]!.n;
      return {
        private_sessions: await n('private_sessions'),
        messages: await n('messages'),
        agents: await n('agents'),
        agent_sessions: await n('agent_sessions'),
        runtime_turns: await n('runtime_turns'),
      };
    });
    expect(counts).toEqual({
      private_sessions: 0,
      messages: 0,
      agents: 0,
      agent_sessions: 0,
      runtime_turns: 0,
    });
    const projects = await t.db.withTenant({ orgId, userId: owner.id }, (tx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM private_projects`.execute(tx),
    );
    expect(projects.rows[0]!.n).toBe(0);
  });

  it('the owner deletes the chat with its messages and AI turn', async () => {
    const deleted = await http()
      .delete(`/v1/private/sessions/${chat.id}`)
      .set('Authorization', as(owner));
    expect(deleted.status).toBe(204);
    expect((await get(owner, `/private/sessions/${chat.id}`)).status).toBe(404);
    const left = await t.db.withUser({ userId: owner.id }, (tx) =>
      sql<{ n: number }>`SELECT count(*)::int AS n FROM messages
                          WHERE private_session_id = ${chat.id}`.execute(tx),
    );
    expect(left.rows[0]!.n).toBe(0);
  });
});
