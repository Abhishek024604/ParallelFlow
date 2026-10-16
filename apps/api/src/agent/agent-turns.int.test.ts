import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  ArenaMessagePage,
  CreateArenaResponse,
  SendArenaMessageResult,
} from '@saras/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@saras/db/testing';
import type { RuntimeClient, RuntimeEvent } from '@saras/runtime-client';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// @AI smoke test (build step 4): a message with @AI queues a turn; a fake runtime answers; the AI's
// message lands in the arena with author_type agent and the turn is completed. Real Nest app and
// database (RLS on); sessions faked with `Authorization: Bearer <user id>`.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

const fakeRuntime: RuntimeClient = {
  createSession: async (req) => ({
    session_id: 'rs-1',
    session_key: req.session_key,
    status: 'ready',
  }),
  createTurn: async (_s, req) => ({ turn_id: req.turn_id, status: 'queued' }),
  async *streamTurnEvents(_s, turnId) {
    const base = { turn_id: turnId, session_id: 'rs-1', at: new Date().toISOString() };
    const events: RuntimeEvent[] = [
      { ...base, seq: 1, type: 'message.delta', data: { text: 'Hello' } },
      { ...base, seq: 2, type: 'message.completed', data: { text: 'Hello team' } },
      { ...base, seq: 3, type: 'turn.completed', data: { usage: { output_tokens: 2 } } },
    ];
    for (const e of events) yield await Promise.resolve(e);
  },
  cancelTurn: async () => undefined,
};

describe.skipIf(!enabled)('@AI in the arena', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  const owner = { id: randomUUID(), name: 'Asha Owner' };
  const as = `Bearer ${owner.id}`;

  beforeAll(async () => {
    t = await createTestDatabase();
    await query(
      t.ownerUrl,
      'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
      [owner.id, `${owner.id.slice(0, 8)}@adva.test`, owner.name, `h${owner.id.slice(0, 8)}`],
    );
    app = await createApp({
      db: t.db,
      sessionVerifier: fakeVerifier,
      runtime: {
        client: fakeRuntime,
        mintToolToken: () => ({
          token: 't',
          expires_at: new Date().toISOString(),
          mcp_url: 'http://x',
        }),
      },
    });
    const created = await request(app.getHttpServer())
      .post('/v1/arenas')
      .set('Authorization', as)
      .set('Idempotency-Key', randomUUID())
      .send({ name: 'AI Arena' });
    projectId = (created.body as CreateArenaResponse).id;
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('queues a turn, stores the AI reply and completes the turn', async () => {
    const posted = await request(app.getHttpServer())
      .post(`/v1/projects/${projectId}/arena/messages`)
      .set('Authorization', as)
      .set('Idempotency-Key', randomUUID())
      .send({ body: '@AI say hello' });
    expect(posted.status).toBe(201);
    const { turn } = posted.body as SendArenaMessageResult;
    expect(turn?.status).toBe('queued');

    const events = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/arena/turns/${turn!.id}/events`)
      .set('Authorization', as);
    expect(events.status).toBe(200);
    expect(events.text).toContain('"type":"status"');

    const page = await request(app.getHttpServer())
      .get(`/v1/projects/${projectId}/arena/messages`)
      .set('Authorization', as);
    const items = (page.body as ArenaMessagePage).items;
    expect(items.at(-1)).toMatchObject({
      body: 'Hello team',
      author: { type: 'agent', display_name: 'AI' },
    });

    const { rows } = await query<{ status: string }>(
      t.ownerUrl,
      'SELECT status FROM saras.runtime_turns WHERE id = $1',
      [turn!.id],
    );
    expect(rows[0]?.status).toBe('completed');
  });

  it('plain messages start no turn', async () => {
    const posted = await request(app.getHttpServer())
      .post(`/v1/projects/${projectId}/arena/messages`)
      .set('Authorization', as)
      .set('Idempotency-Key', randomUUID())
      .send({ body: 'no AI here, mail me@ai.com' });
    expect((posted.body as SendArenaMessageResult).turn).toBeNull();
  });
});
