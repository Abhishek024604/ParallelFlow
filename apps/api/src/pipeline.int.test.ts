import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { Body, Controller, Get, type INestApplication, Param, Post } from '@nestjs/common';
import { ProblemSchema } from '@parallelflow/contracts';
import { createDatabase, type Tx } from '@parallelflow/db';
import {
  createTenantFixture,
  createTestDatabase,
  integrationEnabled,
  query,
  type TenantFixture,
  type TestDatabase,
} from '@parallelflow/db/testing';
import { createLogger } from '@parallelflow/observability';
import type { Request } from 'express';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from './app.js';
import { type SessionVerifier } from './pipeline/auth.js';
import { Caller, DbTx, Idempotent, OrgScoped, ProjectScoped } from './pipeline/decorators.js';
import { ApiError } from './pipeline/errors.js';
import type { CallerContext } from './pipeline/request-context.js';
import { ZodPipe } from './pipeline/validation.js';

// F21-04 request pipeline against a real Nest app and a real database (RLS on). The controller below
// exists only in this test: it exercises each pipeline feature without shipping business endpoints.

const enabled = await integrationEnabled();

/** Test sessions: `Authorization: Bearer <user uuid>`. Stands in for WorkOS (F01-01). */
const fakeVerifier: SessionVerifier = {
  async verify(req: Request) {
    const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    return match ? { userId: match[1]! } : null;
  },
};

const ThingSchema = z.object({ title: z.string().min(1).max(200) }).strict();

const probe = {
  runs: 0,
  gate: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
};

async function countTasks(tx: Tx, title: string): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM tasks WHERE title = ${title}`.execute(tx);
  return rows[0]!.n;
}

@Controller('probe')
class ProbeController {
  @Get('me')
  me(@Caller() caller: CallerContext) {
    return { user_id: caller.userId, org_id: caller.orgId ?? null };
  }

  @Get('projects/:projectId')
  @ProjectScoped()
  async project(@DbTx() tx: Tx, @Caller() caller: CallerContext) {
    const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM arenas`.execute(tx);
    return { org_id: caller.orgId, arenas: rows[0]!.n };
  }

  @Get('orgs/:orgId')
  @OrgScoped()
  org(@Caller() caller: CallerContext) {
    return { org_id: caller.orgId };
  }

  @Post('projects/:projectId/things')
  @ProjectScoped()
  @Idempotent()
  async create(
    @DbTx() tx: Tx,
    @Caller() caller: CallerContext,
    @Param('projectId') projectId: string,
    @Body(new ZodPipe(ThingSchema)) body: z.infer<typeof ThingSchema>,
  ) {
    probe.runs += 1;
    if (probe.gate) {
      probe.entered?.();
      await probe.gate;
    }
    const { rows } = await sql<{ id: string }>`
      INSERT INTO tasks (org_id, project_id, title, created_by)
      VALUES (${caller.orgId}, ${projectId}, ${body.title}, ${caller.userId}) RETURNING id`.execute(
      tx,
    );
    return { id: rows[0]!.id, title: body.title, run: probe.runs, at: new Date().toISOString() };
  }

  @Post('projects/:projectId/refuse')
  @ProjectScoped()
  @Idempotent()
  async refuse(@DbTx() tx: Tx, @Caller() caller: CallerContext, @Param('projectId') id: string) {
    probe.runs += 1;
    await sql`INSERT INTO tasks (org_id, project_id, title, created_by)
              VALUES (${caller.orgId}, ${id}, 'refused-write', ${caller.userId})`.execute(tx);
    throw new ApiError(422, 'REVIEWER_REQUIRED', { detail: 'Pick a reviewer.' });
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail with secret-in-message');
  }
}

function memoryLog() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { lines, logger: createLogger({ destination }) };
}

function expectProblem(res: request.Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(res.headers['content-type']).toMatch(/^application\/problem\+json/);
  const body = JSON.parse(res.text) as unknown;
  const parsed = ProblemSchema.parse(body);
  expect(parsed.code).toBe(code);
  expect(parsed.status).toBe(status);
  expect(parsed.request_id).toBe(res.headers['x-request-id']);
  expect(res.text).not.toMatch(/stack|at .*\.ts:\d+|SELECT |INSERT /);
  return parsed;
}

describe.skipIf(!enabled)('request pipeline (F21-04)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  let app: INestApplication;
  let log: ReturnType<typeof memoryLog>;

  const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    log = memoryLog();
    app = await createApp({
      db: t.db,
      sessionVerifier: fakeVerifier,
      logger: log.logger,
      controllers: [ProbeController],
    });
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  describe('request id', () => {
    it('generates one and echoes it on success and on error', async () => {
      const ok = await http().get('/v1/health');
      expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      const err = await http().get('/v1/probe/me');
      expect(err.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
      expect(err.headers['x-request-id']).not.toBe(ok.headers['x-request-id']);
    });

    it('keeps a well-formed incoming id and replaces a malformed one', async () => {
      const kept = await http().get('/v1/probe/me').set('X-Request-Id', 'edge-123');
      expect(kept.headers['x-request-id']).toBe('edge-123');
      expect(JSON.parse(kept.text).request_id).toBe('edge-123');
      const replaced = await http().get('/v1/health').set('X-Request-Id', 'bad id!');
      expect(replaced.headers['x-request-id']).not.toBe('bad id!');
    });
  });

  describe('auth', () => {
    it('public health answers 200 without a session', async () => {
      const res = await http().get('/v1/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok', database: 'ok' });
    });

    it('no session → 401 UNAUTHENTICATED problem+json', async () => {
      expectProblem(await http().get('/v1/probe/me'), 401, 'UNAUTHENTICATED');
      expectProblem(
        await http().get('/v1/probe/me').set('Authorization', 'Bearer not-a-uuid'),
        401,
        'UNAUTHENTICATED',
      );
    });

    it('without a configured verifier, every authenticated route is 401 (no backdoor)', async () => {
      const bare = await createApp({
        db: t.db,
        logger: memoryLog().logger,
        controllers: [ProbeController],
      });
      try {
        const server = bare.getHttpServer();
        expectProblem(
          await request(server).get('/v1/probe/me').set(as(a.users.owner)),
          401,
          'UNAUTHENTICATED',
        );
        expect((await request(server).get('/v1/health')).status).toBe(200);
      } finally {
        await bare.close();
      }
    });

    it('an unscoped route runs in user scope with the principal', async () => {
      const res = await http().get('/v1/probe/me').set(as(a.users.owner));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user_id: a.users.owner, org_id: null });
    });
  });

  describe('tenant resolution', () => {
    const get = (userId: string, projectId: string) =>
      http().get(`/v1/probe/projects/${projectId}`).set(as(userId));

    it('a project member gets the project org as tenant', async () => {
      const res = await get(a.users.member, a.projectId);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ org_id: a.orgId, arenas: 1 });
    });

    it.each([
      ['an org member who is not a project member', () => a.users.outsider, () => a.projectId],
      ['a member of another org', () => b.users.owner, () => a.projectId],
      ['an unknown project id', () => a.users.owner, () => randomUUID()],
      ['a malformed project id', () => a.users.owner, () => 'not-a-uuid'],
    ])('%s → 404 NOT_FOUND (never 403)', async (_label, user, project) => {
      expectProblem(await get(user(), project()), 404, 'NOT_FOUND');
    });

    it('org routes resolve through withOrgMember', async () => {
      const ok = await http().get(`/v1/probe/orgs/${a.orgId}`).set(as(a.users.outsider));
      expect(ok.body).toEqual({ org_id: a.orgId });
      expectProblem(
        await http().get(`/v1/probe/orgs/${a.orgId}`).set(as(b.users.owner)),
        404,
        'NOT_FOUND',
      );
    });

    it('a suspended member and an expired guest → 403 MEMBERSHIP_INACTIVE', async () => {
      await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
        await sql`UPDATE org_memberships SET status = 'suspended'
                  WHERE org_id = ${a.orgId} AND user_id = ${a.users.member}`.execute(tx);
        await sql`UPDATE org_memberships SET role = 'guest', expires_at = now() - interval '1 hour'
                  WHERE org_id = ${a.orgId} AND user_id = ${a.users.observer}`.execute(tx);
      });
      try {
        expectProblem(await get(a.users.member, a.projectId), 403, 'MEMBERSHIP_INACTIVE');
        expectProblem(await get(a.users.observer, a.projectId), 403, 'MEMBERSHIP_INACTIVE');
        expectProblem(
          await http().get(`/v1/probe/orgs/${a.orgId}`).set(as(a.users.member)),
          403,
          'MEMBERSHIP_INACTIVE',
        );
        // Inactive in org A says nothing about org B.
        expectProblem(await get(a.users.member, b.projectId), 404, 'NOT_FOUND');
      } finally {
        await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
          await sql`UPDATE org_memberships SET status = 'active'
                    WHERE org_id = ${a.orgId} AND user_id = ${a.users.member}`.execute(tx);
          await sql`UPDATE org_memberships SET role = 'member', expires_at = NULL
                    WHERE org_id = ${a.orgId} AND user_id = ${a.users.observer}`.execute(tx);
        });
      }
    });
  });

  describe('idempotency', () => {
    const post = (userId: string, key: string | undefined, body: object, project = a.projectId) => {
      const req = http().post(`/v1/probe/projects/${project}/things`).set(as(userId)).send(body);
      return key === undefined ? req : req.set('Idempotency-Key', key);
    };
    const tasksTitled = (title: string) =>
      t.db.withTenant({ orgId: a.orgId, userId: a.users.owner }, (tx) => countTasks(tx, title));

    it('same key and body → the identical response is replayed and the handler ran once', async () => {
      const key = randomUUID();
      const title = `replay-${key}`;
      const runs = probe.runs;
      const first = await post(a.users.owner, key, { title });
      expect(first.status).toBe(201);
      expect(first.headers['idempotent-replayed']).toBeUndefined();

      const second = await post(a.users.owner, key, { title });
      expect(second.status).toBe(201);
      expect(second.text).toBe(first.text);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(probe.runs).toBe(runs + 1);
      expect(await tasksTitled(title)).toBe(1);
    });

    it('same key, different body → 409 IDEMPOTENCY_KEY_REUSED', async () => {
      const key = randomUUID();
      expect((await post(a.users.owner, key, { title: `a-${key}` })).status).toBe(201);
      expectProblem(
        await post(a.users.owner, key, { title: `b-${key}` }),
        409,
        'IDEMPOTENCY_KEY_REUSED',
      );
    });

    it('missing or malformed key → 400 VALIDATION_FAILED naming the header', async () => {
      const missing = expectProblem(
        await post(a.users.owner, undefined, { title: 'x' }),
        400,
        'VALIDATION_FAILED',
      );
      expect(missing.errors).toEqual([{ field: 'Idempotency-Key', message: 'Required' }]);
      expectProblem(
        await post(a.users.owner, 'has space', { title: 'x' }),
        400,
        'VALIDATION_FAILED',
      );
    });

    it('keys are per user: another user reusing the key gets no replay and no leak', async () => {
      const key = randomUUID();
      const title = `per-user-${key}`;
      const owner = await post(a.users.owner, key, { title });
      const member = await post(a.users.member, key, { title });
      expect(member.status).toBe(201);
      expect(member.headers['idempotent-replayed']).toBeUndefined();
      expect(member.body.id).not.toBe(owner.body.id);
      expect(await tasksTitled(title)).toBe(2);
      // RLS: the member's database context cannot see the owner's record at all.
      const visible = await t.db.withUser(
        { userId: a.users.member },
        async (tx) =>
          (
            await sql<{
              user_id: string;
            }>`SELECT user_id FROM idempotency_keys WHERE key = ${key}`.execute(tx)
          ).rows,
      );
      expect(visible).toEqual([{ user_id: a.users.member }]);
    });

    it('validation errors and domain errors are not stored; a retry runs again', async () => {
      const key = randomUUID();
      const invalid = expectProblem(
        await post(a.users.owner, key, { title: '' }),
        400,
        'VALIDATION_FAILED',
      );
      expect(invalid.errors?.[0]?.field).toBe('title');
      expect((await post(a.users.owner, key, { title: `ok-${key}` })).status).toBe(201);

      const refuseKey = randomUUID();
      const refuse = () =>
        http()
          .post(`/v1/probe/projects/${a.projectId}/refuse`)
          .set(as(a.users.owner))
          .set('Idempotency-Key', refuseKey)
          .send({});
      const runs = probe.runs;
      expectProblem(await refuse(), 422, 'REVIEWER_REQUIRED');
      expectProblem(await refuse(), 422, 'REVIEWER_REQUIRED');
      expect(probe.runs).toBe(runs + 2);
      // The handler's write rolled back with the error.
      expect(await tasksTitled('refused-write')).toBe(0);
    });

    it('a duplicate while the first is still running → 409 CONFLICT, then replays', async () => {
      const key = randomUUID();
      const title = `concurrent-${key}`;
      let release!: () => void;
      probe.gate = new Promise<void>((resolve) => (release = resolve));
      const entered = new Promise<void>((resolve) => (probe.entered = resolve));
      try {
        const first = post(a.users.owner, key, { title }).then((r) => r);
        await entered;
        expectProblem(await post(a.users.owner, key, { title }), 409, 'CONFLICT');
        probe.gate = undefined;
        release();
        const done = await first;
        expect(done.status).toBe(201);
        const replay = await post(a.users.owner, key, { title });
        expect(replay.text).toBe(done.text);
        expect(await tasksTitled(title)).toBe(1);
      } finally {
        probe.gate = undefined;
        probe.entered = undefined;
        release?.();
      }
    });
  });

  describe('errors', () => {
    it('unknown routes → 404 problem+json', async () => {
      expectProblem(await http().get('/v1/nope').set(as(a.users.owner)), 404, 'NOT_FOUND');
      expectProblem(await http().get('/nope'), 404, 'NOT_FOUND');
    });

    it('malformed JSON → 400 VALIDATION_FAILED without echoing it', async () => {
      const res = await http()
        .post(`/v1/probe/projects/${a.projectId}/things`)
        .set(as(a.users.owner))
        .set('Idempotency-Key', randomUUID())
        .set('Content-Type', 'application/json')
        .send('{"title": secret-json');
      expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(res.text).not.toContain('secret-json');
    });

    it('unexpected errors → generic 500 INTERNAL_ERROR, nothing internal leaks', async () => {
      const res = await http().get('/v1/probe/boom').set(as(a.users.owner));
      const problem = expectProblem(res, 500, 'INTERNAL_ERROR');
      expect(res.text).not.toContain('secret-in-message');
      expect(problem.detail).toMatch(/Something went wrong/);
    });
  });

  describe('rate limits', () => {
    let limited: INestApplication;
    let rl: TenantFixture;
    // Middle of a fixed minute far from the real clock, so these windows are their own.
    const now = Date.UTC(2030, 0, 1, 12, 0, 20);

    beforeAll(async () => {
      rl = await createTenantFixture(t.db, 'rl');
      limited = await createApp({
        db: t.db,
        sessionVerifier: fakeVerifier,
        logger: memoryLog().logger,
        controllers: [ProbeController],
        rateLimits: { userPerWindow: 3, orgPerWindow: 5 },
        clock: () => now,
      });
    });

    afterAll(async () => {
      await limited?.close();
    });

    const get = (userId: string, path = '/v1/probe/me') =>
      request(limited.getHttpServer()).get(path).set(as(userId));

    it('sends RateLimit-* headers and answers 429 RATE_LIMITED with Retry-After past the user limit', async () => {
      const user = rl.users.outsider;
      const first = await get(user);
      expect(first.status).toBe(200);
      expect(first.headers).toMatchObject({
        'ratelimit-limit': '3',
        'ratelimit-remaining': '2',
        'ratelimit-reset': '40',
      });
      await get(user);
      expect((await get(user)).headers['ratelimit-remaining']).toBe('0');
      const over = await get(user);
      expectProblem(over, 429, 'RATE_LIMITED');
      expect(over.headers['retry-after']).toBe('40');
      expect(over.headers['ratelimit-remaining']).toBe('0');
    });

    it('applies the org limit across members of the org', async () => {
      const path = `/v1/probe/projects/${rl.projectId}`;
      const statuses: number[] = [];
      for (const user of [rl.users.owner, rl.users.member, rl.users.observer]) {
        statuses.push((await get(user, path)).status, (await get(user, path)).status);
      }
      // 6 requests from 3 users (2 each, under the user limit of 3) against an org limit of 5.
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
      const res = await get(rl.users.owner, path);
      expectProblem(res, 429, 'RATE_LIMITED');
      expect(res.headers['ratelimit-limit']).toBe('5');
    });

    it('the counters hold one row per subject and window', async () => {
      const { rows } = await query<{ bucket: string; hits: number }>(
        t.ownerUrl,
        `SELECT bucket, hits FROM saras.rate_limit_counters WHERE subject_id = $1`,
        [rl.orgId],
      );
      expect(rows).toEqual([{ bucket: 'org', hits: 7 }]);
    });
  });

  describe('startup', () => {
    it('refuses a database role that can bypass RLS', async () => {
      const owner = createDatabase({ connectionString: t.ownerUrl });
      try {
        await expect(createApp({ db: owner, logger: memoryLog().logger })).rejects.toThrow(
          /Unsafe database role/,
        );
      } finally {
        await owner.destroy();
      }
    });
  });

  describe('logging', () => {
    it('logs ids and the route template, never bodies, cookies, auth, keys or query tokens', async () => {
      const marker = randomUUID();
      const res = await http()
        .post(`/v1/probe/projects/${a.projectId}/things?token=QUERY-SECRET`)
        .set(as(a.users.owner))
        .set('Cookie', 'parallelflow_session=COOKIE-SECRET')
        .set('Idempotency-Key', 'IDEM-SECRET-KEY')
        .set('X-Request-Id', marker)
        .send({ title: 'BODY-SECRET' });
      expect(res.status).toBe(201);
      await http().get('/v1/probe/boom').set(as(a.users.owner)).set('X-Request-Id', `${marker}-b`);

      const out = log.lines.join('');
      for (const secret of [
        'QUERY-SECRET',
        'COOKIE-SECRET',
        'IDEM-SECRET-KEY',
        'BODY-SECRET',
        `Bearer ${a.users.owner}`,
        'secret-in-message',
      ]) {
        expect(out).not.toContain(secret);
      }
      const lines = log.lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const line = lines.find((l) => l.request_id === marker);
      expect(line).toMatchObject({
        method: 'POST',
        route: '/v1/probe/projects/:projectId/things',
        status: 201,
        user_id: a.users.owner,
        org_id: a.orgId,
      });
      expect(line?.latency_ms).toEqual(expect.any(Number));
      expect(lines.find((l) => l.request_id === `${marker}-b`)).toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        err_name: 'Error',
      });
    });
  });
});
