import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  Artifact,
  ArtifactList,
  CreateArenaResponse,
  PrivateChat,
  PushPreview,
  PushResult,
} from '@saras/contracts';
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

// The bridge smoke test (build step 6, ADR-034): the owner pushes a private file into their arena →
// the arena gets the artifact, the chat becomes linked, a bridge event exists in the arena's org, and
// pushing to another arena is 409. Someone else cannot read the private file (404), and an upload of
// a disallowed type is rejected. Real Nest app and database (RLS on); sessions faked.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('the bridge: push to arena and files', () => {
  let t: TestDatabase;
  let app: INestApplication;
  const owner = { id: randomUUID(), name: 'Abhishek Owner' };
  const other = { id: randomUUID(), name: 'Riya Other' };
  let arenaA: CreateArenaResponse;
  let arenaB: CreateArenaResponse;
  let chat: PrivateChat;
  let file: Artifact;

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
        [u.id, `${u.id.slice(0, 8)}@bridge.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });
    arenaA = (await create(owner, '/arenas', { name: 'Checkout' })).body as CreateArenaResponse;
    arenaB = (await create(owner, '/arenas', { name: 'Search' })).body as CreateArenaResponse;
    chat = (await create(owner, '/private/sessions', { title: 'Goal draft' })).body as PrivateChat;
    const made = await create(owner, '/artifacts', {
      scope: 'private',
      kind: 'goal',
      name: 'goal.md',
      content: '# Goal\n\nShip checkout v2.\n',
      private_session_id: chat.id,
    });
    expect(made.status).toBe(201);
    file = made.body as Artifact;
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  it('only the owner can read the private file', async () => {
    expect((await get(owner, `/artifacts/${file.id}`)).status).toBe(200);
    expect((await get(other, `/artifacts/${file.id}`)).status).toBe(404);
    expect((await get(other, `/artifacts/${file.id}/versions/1/content`)).status).toBe(404);
    const theirs = (await get(other, '/artifacts')).body as ArtifactList;
    expect(theirs.items).toEqual([]);
  });

  it('the preview offers a new artifact and says the chat will be linked', async () => {
    const res = await get(owner, `/artifacts/${file.id}/push-preview?project_id=${arenaA.id}`);
    expect(res.status).toBe(200);
    const preview = res.body as PushPreview;
    expect(preview).toMatchObject({
      destination: { project_id: arenaA.id },
      destination_locked: false,
      mode: 'new',
      binds_session: true,
      diff: { added: 3, removed: 0 },
    });
  });

  it('push copies the version into the arena, links the chat and records the crossing', async () => {
    const res = await create(owner, `/artifacts/${file.id}/push`, {
      project_id: arenaA.id,
      version_no: 1,
    });
    expect(res.status).toBe(201);
    const pushed = res.body as PushResult;
    expect(pushed).toMatchObject({ mode: 'new', version_no: 1, session_bound: true });
    expect(pushed.message_id).not.toBeNull();

    const arenaFiles = (await get(owner, `/projects/${arenaA.id}/artifacts`)).body as ArtifactList;
    expect(arenaFiles.items.map((a) => [a.id, a.name, a.scope])).toEqual([
      [pushed.artifact_id, 'goal.md', 'project'],
    ]);
    const content = await get(
      owner,
      `/projects/${arenaA.id}/artifacts/${pushed.artifact_id}/versions/1/content`,
    );
    expect(content.status).toBe(200);
    expect(content.text).toContain('Ship checkout v2.');

    const linked = (await get(owner, `/private/sessions/${chat.id}`)).body as PrivateChat;
    expect(linked.bound_project?.id).toBe(arenaA.id);

    const { rows } = await query<{ n: number }>(
      t.ownerUrl,
      `SELECT count(*)::int AS n FROM saras.bridge_events b JOIN saras.projects p ON p.id = b.project_id
        WHERE b.project_id = $1 AND b.org_id = p.org_id AND b.private_session_id = $2
          AND b.direction = 'push_artifact' AND b.user_id = $3`,
      [arenaA.id, chat.id, owner.id],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('pushing the linked chat to another arena is 409, and nothing lands there', async () => {
    const res = await create(owner, `/artifacts/${file.id}/push`, {
      project_id: arenaB.id,
      version_no: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'BRIDGE_SCOPE_MISMATCH' });
    const inB = (await get(owner, `/projects/${arenaB.id}/artifacts`)).body as ArtifactList;
    expect(inB.items).toEqual([]);
  });

  it('rejects an upload of a disallowed type, and one whose bytes lie about the type', async () => {
    const html = await http()
      .post('/v1/private/files?name=page.html&mime_type=text/html')
      .set('Authorization', as(owner))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('<html><script>alert(1)</script></html>'));
    expect(html.status).toBe(400);

    const fakePng = await http()
      .post('/v1/private/files?name=x.png&mime_type=image/png')
      .set('Authorization', as(owner))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('%PDF-1.7 not a png'));
    expect(fakePng.status).toBe(400);

    const ok = await http()
      .post('/v1/private/files?name=notes.txt&mime_type=text/plain')
      .set('Authorization', as(owner))
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('plain notes'));
    expect(ok.status).toBe(201);
    const download = await get(owner, `/private/files/${(ok.body as { file_id: string }).file_id}`);
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['content-disposition']).toMatch(/^attachment;/);
    expect(
      (await get(other, `/private/files/${(ok.body as { file_id: string }).file_id}`)).status,
    ).toBe(404);
  });
});
