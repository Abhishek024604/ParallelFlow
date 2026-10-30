import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type {
  Artifact,
  ArtifactList,
  CreateArenaResponse,
  PrivateChat,
  PushFolderPreview,
  PushFolderResult,
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

// Push a folder to an arena (smoke test): the owner pushes a chat's "pm › backlog" folder → each
// story gets its own name in the arena's Backlog folder, one bridge event and one arena card cover
// the batch, the chat is linked; pushing again changes nothing until a file changes; a non-member
// cannot push the folder into the arena. Real Nest app and database (RLS on); sessions faked.

const enabled = await integrationEnabled();

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('push a folder to the arena', () => {
  let t: TestDatabase;
  let app: INestApplication;
  const owner = { id: randomUUID(), name: 'John Owner' };
  const other = { id: randomUUID(), name: 'Riya Other' };
  let arena: CreateArenaResponse;
  let chat: PrivateChat;
  const files: Artifact[] = [];

  const as = (user: { id: string }) => `Bearer ${user.id}`;
  const http = () => request(app.getHttpServer());
  const post = (user: { id: string }, path: string, body: object) =>
    http()
      .post(`/v1${path}`)
      .set('Authorization', as(user))
      .set('Idempotency-Key', randomUUID())
      .send(body);
  const get = (user: { id: string }, path: string) =>
    http().get(`/v1${path}`).set('Authorization', as(user));
  const base = () => `/private/sessions/${chat.id}/bridge/push-folder`;

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const u of [owner, other]) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, `${u.id.slice(0, 8)}@folder.test`, u.name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier });
    arena = (await post(owner, '/arenas', { name: 'Checkout' })).body as CreateArenaResponse;
    chat = (await post(owner, '/private/sessions', { title: 'Backlog' })).body as PrivateChat;
    for (const story of ['STORY-001', 'STORY-002', 'EPIC-001']) {
      const made = await post(owner, '/artifacts', {
        scope: 'private',
        kind: 'document',
        name: `pm › backlog › ${story}.md`,
        content: `# ${story}\n`,
        private_session_id: chat.id,
      });
      expect(made.status).toBe(201);
      files.push(made.body as Artifact);
    }
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  const body = () => ({
    project_id: arena.id,
    folder: 'backlog',
    artifact_ids: files.map((f) => f.id),
  });

  it('the preview gives each file its own name in the Backlog folder', async () => {
    const res = await post(owner, `${base()}/preview`, body());
    expect(res.status).toBe(200);
    const preview = res.body as PushFolderPreview;
    expect(preview.files.map((f) => [f.arena_name, f.action])).toEqual([
      ['Backlog › requirements-story-001.md', 'new'],
      ['Backlog › requirements-story-002.md', 'new'],
      ['Backlog › requirements-epic-001.md', 'new'],
    ]);
    expect(preview.binds_session).toBe(true);
  });

  it('a non-member cannot push the folder (the files are not theirs either)', async () => {
    const res = await post(other, base(), body());
    expect([400, 403, 404]).toContain(res.status);
    const inArena = (await get(owner, `/projects/${arena.id}/artifacts`)).body as ArtifactList;
    expect(inArena.items.filter((a) => a.name.startsWith('Backlog'))).toEqual([]);
  });

  it('pushes the batch in one transaction: one event, one card, the chat linked', async () => {
    const res = await post(owner, base(), body());
    expect(res.status).toBe(201);
    const result = res.body as PushFolderResult;
    expect(result.counts).toEqual({ new: 3, new_version: 0, unchanged: 0 });
    expect(result.session_bound).toBe(true);
    expect(result.message_id).not.toBeNull();

    const inArena = (await get(owner, `/projects/${arena.id}/artifacts`)).body as ArtifactList;
    expect(
      inArena.items
        .map((a) => a.name)
        .filter((n) => n.startsWith('Backlog'))
        .sort(),
    ).toEqual([
      'Backlog › requirements-epic-001.md',
      'Backlog › requirements-story-001.md',
      'Backlog › requirements-story-002.md',
    ]);
    const { rows } = await query<{ events: number; cards: number }>(
      t.ownerUrl,
      `SELECT (SELECT count(*)::int FROM saras.bridge_events
                WHERE project_id = $1 AND direction = 'push_artifact' AND ref ->> 'batch' = 'true') AS events,
              (SELECT count(*)::int FROM saras.messages m JOIN saras.arenas a ON a.id = m.arena_id
                WHERE a.project_id = $1 AND cardinality(m.artifact_refs) = 3) AS cards`,
      [arena.id],
    );
    expect(rows[0]).toEqual({ events: 1, cards: 1 });
  });

  it('pushing again: unchanged files stay as they are; a changed one gets a new version', async () => {
    const same = (await post(owner, base(), body())).body as PushFolderResult;
    expect(same.counts).toEqual({ new: 0, new_version: 0, unchanged: 3 });
    expect(same.message_id).toBeNull();

    const edited = await post(owner, `/artifacts/${files[0]!.id}/versions`, {
      content: '# STORY-001\n\nNow with acceptance criteria.\n',
    });
    expect(edited.status).toBe(201);
    const again = (await post(owner, base(), body())).body as PushFolderResult;
    expect(again.counts).toEqual({ new: 0, new_version: 1, unchanged: 2 });
    expect(again.files[0]).toMatchObject({
      name: 'Backlog › requirements-story-001.md',
      version_no: 2,
      action: 'new_version',
    });
  });
});
