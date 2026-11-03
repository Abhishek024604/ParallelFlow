import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { AiKeyStatus, CreateArenaResponse } from '@parallelflow/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@parallelflow/db/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// Bring your own AI key smoke test (ADR-043): your own key is checked with the provider, sealed and
// never returned; an arena's key is the owner's to change, a member sees its status only, and a
// non-member gets nothing. Real Nest app and database (RLS on); the provider's check is stubbed.

const enabled = await integrationEnabled();
const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};
const GOOD = 'sk-good-key-0000-1234';

describe.skipIf(!enabled)('ai keys: your own and the arena owner’s', () => {
  let t: TestDatabase;
  let app: INestApplication;
  let projectId: string;
  const owner = { id: randomUUID(), name: 'Owner' };
  const member = { id: randomUUID(), name: 'Member' };
  const stranger = { id: randomUUID(), name: 'Stranger' };
  const as = (u: { id: string }) => `Bearer ${u.id}`;
  const body = { provider: 'openai', model: 'gpt-4.1', api_key: GOOD };

  beforeAll(async () => {
    // The provider accepts GOOD only.
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      if (!String(url).startsWith('https://api.openai.com/')) return real(url, init);
      const auth = new Headers(init?.headers).get('authorization');
      return new Response('{}', { status: auth === `Bearer ${GOOD}` ? 200 : 401 });
    });
    t = await createTestDatabase();
    for (const u of [owner, member, stranger]) {
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
      .send({ name: 'Keys' });
    expect(created.status).toBe(201);
    projectId = (created.body as CreateArenaResponse).id;
    const { rows } = await query<{ org_id: string; role: string }>(
      t.ownerUrl,
      `SELECT org_id, id AS role FROM saras.project_roles WHERE project_id = $1 AND key = 'member'`,
      [projectId],
    );
    const { org_id: org, role } = rows[0]!;
    await query(
      t.ownerUrl,
      `INSERT INTO saras.org_memberships (org_id, user_id, role) VALUES ($1, $2, 'member')`,
      [org, member.id],
    );
    await query(
      t.ownerUrl,
      'INSERT INTO saras.project_members (org_id, project_id, user_id) VALUES ($1, $2, $3)',
      [org, projectId, member.id],
    );
    await query(
      t.ownerUrl,
      'INSERT INTO saras.project_member_roles (org_id, project_id, user_id, role_id) VALUES ($1, $2, $3, $4)',
      [org, projectId, member.id, role],
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await t?.cleanup();
  });

  it('saves your own key sealed, shows only its last 4, and refuses a bad key', async () => {
    const http = request(app.getHttpServer());
    const bad = await http
      .put('/v1/me/ai-key')
      .set('Authorization', as(member))
      .send({ ...body, api_key: 'sk-wrong-key-9999' });
    expect(bad.status).toBe(422);
    const saved = await http.put('/v1/me/ai-key').set('Authorization', as(member)).send(body);
    expect(saved.status).toBe(200);
    expect((saved.body as AiKeyStatus).key).toMatchObject({
      provider: 'openai',
      model: 'gpt-4.1',
      last4: '1234',
    });
    expect(JSON.stringify(saved.body)).not.toContain(GOOD);
    const { rows } = await query<{ secret_sealed: string }>(
      t.ownerUrl,
      'SELECT secret_sealed FROM saras.ai_provider_keys WHERE user_id = $1',
      [member.id],
    );
    expect(rows[0]?.secret_sealed).not.toContain(GOOD);
    // Someone else's own key is never visible.
    const theirs = await http.get('/v1/me/ai-key').set('Authorization', as(owner));
    expect((theirs.body as AiKeyStatus).key).toBeNull();
  });

  it('only the owner changes the arena key; a member sees its status; a non-member nothing', async () => {
    const http = request(app.getHttpServer());
    const path = `/v1/projects/${projectId}/ai-key`;
    expect((await http.put(path).set('Authorization', as(member)).send(body)).status).toBe(403);
    const saved = await http.put(path).set('Authorization', as(owner)).send(body);
    expect(saved.status).toBe(200);
    const seen = await http.get(path).set('Authorization', as(member));
    expect(seen.status).toBe(200);
    expect(seen.body).toMatchObject({
      key: { provider: 'openai', last4: '1234' },
      can_edit: false,
    });
    expect(JSON.stringify(seen.body)).not.toContain(GOOD);
    expect([403, 404]).toContain((await http.get(path).set('Authorization', as(stranger))).status);
    const removed = await http.delete(path).set('Authorization', as(owner));
    expect((removed.body as AiKeyStatus).key).toBeNull();
  });
});
