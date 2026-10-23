import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Artifact, CreateArenaResponse } from '@parallelflow/contracts';
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

// The owner approves an arena document's latest version, and you your own private file (SWA gates
// read these approvals): 200 for the latest, 409 for an older one, 404 for anyone else.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('approving an arena document', () => {
  let t: TestDatabase;
  let app: INestApplication;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const outsider = { id: randomUUID(), name: 'Riya Outside' };
  let arena: CreateArenaResponse;
  let doc: Artifact;

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const http = () => request(app.getHttpServer());
  const post = (user: { id: string }, path: string, body: object) =>
    http()
      .post(`/v1${path}`)
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID())
      .send(body);

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, outsider]) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, `${u.id.slice(0, 8)}@approve.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });
    arena = (await post(owner, '/arenas', { name: 'Payments' })).body as CreateArenaResponse;
    const made = await post(owner, `/projects/${arena.id}/artifacts`, {
      scope: 'project',
      kind: 'document',
      name: 'arch/00-drivers.md',
      content: '# Drivers\n',
    });
    expect(made.status).toBe(201);
    doc = made.body as Artifact;
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('approves the latest version, refuses an older one and hides it from outsiders', async () => {
    const path = `/projects/${arena.id}/artifacts/${doc.id}/approve`;
    const ok = await post(owner, path, { version_no: 1 });
    expect(ok.status).toBe(200);
    expect((ok.body as Artifact).approved_version_no).toBe(1);

    expect(
      (
        await post(owner, `/projects/${arena.id}/artifacts/${doc.id}/versions`, {
          content: '# Drivers\n\nEdited.\n',
        })
      ).status,
    ).toBe(201);
    expect((await post(owner, path, { version_no: 1 })).status).toBe(409);
    expect((await post(outsider, path, { version_no: 2 })).status).toBe(404);
    expect((await post(owner, path, { version_no: 2 })).status).toBe(200);
  });

  it('lets you approve your own private file, and nobody else', async () => {
    const chat = (await post(owner, '/private/sessions', { title: 'Design' })).body as {
      id: string;
    };
    const made = await post(owner, '/artifacts', {
      scope: 'private',
      kind: 'document',
      name: 'arch/stack.md',
      content: '# Stack\n',
      private_session_id: chat.id,
    });
    expect(made.status).toBe(201);
    const file = made.body as Artifact;
    expect((await post(outsider, `/artifacts/${file.id}/approve`, { version_no: 1 })).status).toBe(
      404,
    );
    const ok = await post(owner, `/artifacts/${file.id}/approve`, { version_no: 1 });
    expect(ok.status).toBe(200);
    expect((ok.body as Artifact).approved_version_no).toBe(1);
  });
});
