import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { type ArenaList, type CreateArenaResponse, parseInviteToken } from '@parallelflow/contracts';
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
import { MEMBER_CAPABILITIES } from './create-arena.js';
import { inviteSecretHash } from './naming.js';

// Create arena → invite link → join, against a real Nest app and database (RLS on). Sessions are
// faked with `Authorization: Bearer <user id>` (the WorkOS verifier is covered by auth.int.test.ts).

const enabled = await integrationEnabled();
const WEB = 'http://localhost:3000';

const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

describe.skipIf(!enabled)('arenas: create, invite links, join', () => {
  let t: TestDatabase;
  let app: INestApplication;
  const owner = { id: randomUUID(), email: `owner-${randomUUID().slice(0, 8)}@adva.test` };
  const riya = { id: randomUUID(), email: `riya-${randomUUID().slice(0, 8)}@adva.test` };
  const stranger = { id: randomUUID(), email: `x-${randomUUID().slice(0, 8)}@adva.test` };

  beforeAll(async () => {
    t = await createTestDatabase();
    for (const [u, name] of [
      [owner, 'Abhishek Owner'],
      [riya, 'Riya Sharma'],
      [stranger, 'Sam Stranger'],
    ] as const) {
      await query(
        t.ownerUrl,
        'INSERT INTO saras.users (id, email, display_name, handle) VALUES ($1, $2, $3, $4)',
        [u.id, u.email, name, `h${u.id.slice(0, 8)}`],
      );
    }
    app = await createApp({ db: t.db, sessionVerifier: fakeVerifier, webOrigin: WEB });
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  const as = (user: { id: string }) => `Bearer ${user.id}`;

  it('creates an arena, lists it for members only, and joins once per link', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/arenas')
      .set('Authorization', as(owner))
      .set('Idempotency-Key', randomUUID())
      .send({
        name: 'Interview Prep',
        description: 'Mock interviews with instant feedback.',
        invite_emails: [riya.email.toUpperCase(), 'karan@adva.test', owner.email],
      });
    expect(created.status).toBe(201);
    const body = created.body as CreateArenaResponse;
    expect(body).toMatchObject({ name: 'Interview Prep', key: 'IP', cycle: 1, stage: 'PLAN' });
    expect(body.member_count).toBe(1);
    expect(body.role).toBe('owner');
    // The creator's own email is dropped; the rest are lower-cased.
    expect(body.invites.map((i) => i.email)).toEqual([riya.email, 'karan@adva.test']);
    const link = body.invites[0]!.link!;
    expect(link.startsWith(`${WEB}/join/`)).toBe(true);
    const token = link.slice(`${WEB}/join/`.length);
    const parsed = parseInviteToken(token)!;
    expect(parsed).not.toBeNull();

    // Rows, read as the owner role (assertions only).
    const org = parsed.orgId;
    const count = async (table: string, where = 'org_id = $1') =>
      Number(
        (
          await query<{ n: string }>(
            t.ownerUrl,
            `SELECT count(*) AS n FROM saras.${table} WHERE ${where}`,
            [org],
          )
        ).rows[0]!.n,
      );
    expect(await count('organizations', 'id = $1')).toBe(1);
    expect(await count('org_policies')).toBe(1);
    expect(await count('org_memberships')).toBe(1);
    expect(await count('teams')).toBe(1);
    expect(await count('projects')).toBe(1);
    expect(await count('project_roles')).toBe(2);
    expect(await count('stage_gate_policies')).toBe(5);
    expect(await count('agent_policies')).toBe(7);
    expect(await count('arenas')).toBe(1);
    expect(await count('agents')).toBe(1);
    expect(await count('sdlc_cycles')).toBe(1);
    const { rows: caps } = await query<{ capability: string }>(
      t.ownerUrl,
      `SELECT rc.capability FROM saras.role_capabilities rc
       JOIN saras.project_roles r ON r.id = rc.role_id WHERE r.org_id = $1 AND r.key = 'member'
       ORDER BY 1`,
      [org],
    );
    expect(caps.map((c) => c.capability)).toEqual([...MEMBER_CAPABILITIES].sort());
    const { rows: sessions } = await query<{ session_key: string; status: string }>(
      t.ownerUrl,
      'SELECT session_key, status FROM saras.agent_sessions WHERE org_id = $1',
      [org],
    );
    expect(sessions).toEqual([
      { session_key: `org/${org}/project/${body.id}/arena`, status: 'provisioning' },
    ]);
    const { rows: invites } = await query<{ email: string; token_hash: string }>(
      t.ownerUrl,
      'SELECT email, token_hash FROM saras.invitations WHERE org_id = $1 ORDER BY email',
      [org],
    );
    expect(invites).toHaveLength(2);
    expect(invites.find((i) => i.email === riya.email)!.token_hash).toBe(
      inviteSecretHash(parsed.secret),
    );
    // The secret itself is stored nowhere: not in invitations, not in the idempotency record.
    const { rows: leaks } = await query(
      t.ownerUrl,
      `SELECT 1 FROM saras.idempotency_keys WHERE response_body LIKE '%' || $1 || '%'
       UNION ALL SELECT 1 FROM saras.invitations WHERE token_hash = $1`,
      [parsed.secret],
    );
    expect(leaks).toHaveLength(0);
    const { rows: events } = await query<{ type: string }>(
      t.ownerUrl,
      'SELECT type FROM saras.outbox_events WHERE org_id = $1 ORDER BY type',
      [org],
    );
    expect(events.map((e) => e.type)).toEqual([
      'member.invited',
      'member.invited',
      'project.setup_completed',
    ]);

    // Listed for the owner, not for anyone else.
    const mine = await request(app.getHttpServer())
      .get('/v1/arenas')
      .set('Authorization', as(owner));
    expect((mine.body as ArenaList).items.map((a) => a.id)).toEqual([body.id]);
    const theirs = await request(app.getHttpServer())
      .get('/v1/arenas')
      .set('Authorization', as(stranger));
    expect((theirs.body as ArenaList).items).toEqual([]);
    const peek = await request(app.getHttpServer())
      .get(`/v1/arenas/${body.id}`)
      .set('Authorization', as(stranger));
    expect(peek.status).toBe(404);

    // Public preview: masked email when signed out.
    const preview = await request(app.getHttpServer()).get(`/v1/invites/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({
      arena: { name: 'Interview Prep', member_count: 1 },
      invited_by: { display_name: 'Abhishek Owner' },
      email_matches: null,
    });
    expect(preview.body.email).toMatch(/^r\*\*\*@adva\.test$/);

    // Wrong account → 403; right account → joins; second use → 410.
    const wrong = await request(app.getHttpServer())
      .post(`/v1/invites/${token}:accept`)
      .set('Authorization', as(stranger));
    expect(wrong.status).toBe(403);
    const joined = await request(app.getHttpServer())
      .post(`/v1/invites/${token}:accept`)
      .set('Authorization', as(riya));
    expect(joined.status).toBe(200);
    expect(joined.body.arena).toEqual({ id: body.id, name: 'Interview Prep' });
    const again = await request(app.getHttpServer())
      .post(`/v1/invites/${token}:accept`)
      .set('Authorization', as(riya));
    expect(again.status).toBe(410);
    expect(again.body.code).toBe('INVITE_EXPIRED');

    const riyas = await request(app.getHttpServer())
      .get('/v1/arenas')
      .set('Authorization', as(riya));
    expect((riyas.body as ArenaList).items).toMatchObject([
      { id: body.id, role: 'member', member_count: 2 },
    ]);
    expect(await count('outbox_events', "org_id = $1 AND type = 'member.joined'")).toBe(1);
  });
});
