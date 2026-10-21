import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Artifact, CreateArenaResponse } from '@saras/contracts';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from '@saras/db/testing';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import type { SessionVerifier } from '../pipeline/auth.js';

// The owner approves an arena document's latest version (SWA gates in an arena read these
// approvals): 200 for the latest, 409 for an older one, 404 for someone outside the arena.

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
});
