import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { INestApplication } from '@nestjs/common';
import { MeSchema, ProblemSchema } from '@saras/contracts';
import {
  createTenantFixture,
  createTestDatabase,
  integrationEnabled,
  type TenantFixture,
  type TestDatabase,
} from '@saras/db/testing';
import { createLogger } from '@saras/observability';
import { sql } from 'kysely';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { pkceChallenge } from './crypto.js';
import type {
  CodeExchange,
  IdentityProvider,
  IdpUser,
  SessionCheck,
  SessionRefresh,
} from './identity-provider.js';

// F01-01 against a real Nest app and a real database (RLS on). WorkOS is replaced by a fake provider
// with the same contract: sealed sessions with a 5-minute access token, single-use codes bound to a
// PKCE challenge, refresh, and revocation. Like WorkOS, the fake verifies access tokens locally, so a
// revoked session keeps a valid access token until it expires: the API must reject it by itself.

const enabled = await integrationEnabled();

const WEB = 'http://localhost:3000';
const COOKIE_PASSWORD = 'test-cookie-password-'.padEnd(48, 'x');
const MIN = 60_000;
const H = 60 * MIN;

class FakeIdentityProvider implements IdentityProvider {
  now: () => number = Date.now;
  readonly accessTtlMs = 5 * MIN;
  readonly codes = new Map<string, IdpUser>();
  readonly challenges = new Set<string>();
  readonly revoked: string[] = [];
  refreshes = 0;

  authorizationUrl(input: { state: string; codeChallenge: string }): string {
    this.challenges.add(input.codeChallenge);
    const url = new URL('https://auth.example.test/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('code_challenge', input.codeChallenge);
    return url.toString();
  }

  async exchangeCode(input: { code: string; codeVerifier: string }): Promise<CodeExchange> {
    const user = this.codes.get(input.code);
    this.codes.delete(input.code);
    if (!user || !this.challenges.has(pkceChallenge(input.codeVerifier))) {
      throw new Error(`invalid_grant for ${input.code}`);
    }
    const sessionId = `session_${randomUUID()}`;
    return { sessionId, user, sealedSession: this.seal(sessionId, user) };
  }

  async authenticate(sealed: string): Promise<SessionCheck> {
    const data = this.unseal(sealed);
    if (!data) return { status: 'invalid' };
    if (data.exp <= this.now()) return { status: 'expired' };
    return { status: 'valid', sessionId: data.sid, user: data.user };
  }

  async refresh(sealed: string): Promise<SessionRefresh> {
    const data = this.unseal(sealed);
    if (!data || this.revoked.includes(data.sid)) return { status: 'ended' };
    this.refreshes += 1;
    return {
      status: 'refreshed',
      sessionId: data.sid,
      user: data.user,
      sealedSession: this.seal(data.sid, data.user),
    };
  }

  async revoke(sessionId: string): Promise<void> {
    this.revoked.push(sessionId);
  }

  private seal(sid: string, user: IdpUser): string {
    const body = { sid, user, exp: this.now() + this.accessTtlMs, n: randomUUID() };
    return `fake*${Buffer.from(JSON.stringify(body)).toString('base64url')}~2`;
  }

  private unseal(sealed: string): { sid: string; user: IdpUser; exp: number } | undefined {
    const match = /^fake\*([A-Za-z0-9_-]+)~2$/.exec(sealed);
    if (!match) return undefined;
    try {
      return JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8'));
    } catch {
      return undefined;
    }
  }
}

interface SetCookie {
  value: string;
  attrs: string[];
}

function setCookies(res: request.Response): Map<string, SetCookie> {
  const raw = res.headers['set-cookie'] as unknown;
  const list = Array.isArray(raw) ? (raw as string[]) : typeof raw === 'string' ? [raw] : [];
  const out = new Map<string, SetCookie>();
  for (const line of list) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const eq = pair!.indexOf('=');
    out.set(pair!.slice(0, eq), { value: pair!.slice(eq + 1), attrs });
  }
  return out;
}

function attr(cookie: SetCookie | undefined, name: string): string | true | undefined {
  for (const a of cookie?.attrs ?? []) {
    const [key, value] = a.split('=');
    if (key!.toLowerCase() === name.toLowerCase()) return value ?? true;
  }
  return undefined;
}

function isCleared(cookie: SetCookie | undefined): boolean {
  const expires = attr(cookie, 'Expires');
  return cookie?.value === '' && typeof expires === 'string' && new Date(expires).getTime() <= 0;
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
  const parsed = ProblemSchema.parse(JSON.parse(res.text));
  expect(parsed.code).toBe(code);
  expect(parsed.request_id).toBe(res.headers['x-request-id']);
  return parsed;
}

interface Session {
  userId: string;
  session: string;
  csrf: string;
  cookie: string;
  sessionId: string;
}

describe.skipIf(!enabled)('WorkOS login, sessions, CSRF and /me (F01-01)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  let app: INestApplication;
  let fake: FakeIdentityProvider;
  let log: ReturnType<typeof memoryLog>;
  let now = Date.UTC(2031, 0, 6, 9, 0, 0);
  /** Every secret the tests handle; none may appear in the log. */
  const secrets = new Set<string>();

  const http = () => request(app.getHttpServer());

  function profile(email: string, extra: Partial<IdpUser> = {}): IdpUser {
    return {
      id: `user_${randomUUID()}`,
      email,
      emailVerified: true,
      firstName: 'Priya',
      lastName: 'K',
      ...extra,
    };
  }

  async function startLogin(returnTo?: string) {
    const query = returnTo === undefined ? '' : `?return_to=${encodeURIComponent(returnTo)}`;
    const res = await http().get(`/v1/auth/login${query}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location as string);
    const state = location.searchParams.get('state')!;
    const login = setCookies(res).get('saras_login')!;
    secrets.add(state);
    secrets.add(login.value);
    return { res, state, login, location };
  }

  async function callback(user: IdpUser, opts: { returnTo?: string } = {}) {
    const { state, login } = await startLogin(opts.returnTo);
    const code = `code-${randomUUID()}`;
    secrets.add(code);
    fake.codes.set(code, user);
    return http()
      .get(`/v1/auth/callback?code=${code}&state=${state}`)
      .set('Cookie', `saras_login=${login.value}`);
  }

  async function signIn(email: string, extra: Partial<IdpUser> = {}): Promise<Session> {
    const res = await callback(profile(email, extra));
    expect(res.status).toBe(302);
    const cookies = setCookies(res);
    const session = cookies.get('saras_session')!.value;
    const csrf = cookies.get('saras_csrf')!.value;
    secrets.add(session);
    secrets.add(csrf);
    const me = await http().get('/v1/me').set('Cookie', `saras_session=${session}`);
    expect(me.status).toBe(200);
    return {
      userId: me.body.id,
      session,
      csrf,
      cookie: `saras_session=${session}; saras_csrf=${csrf}`,
      sessionId: sessionIdOf(session),
    };
  }

  /** The fake's sid inside our envelope (test-only peek; production never decodes it). */
  function sessionIdOf(session: string): string {
    const sealed = decodeURIComponent(session).split('.').slice(3).join('.');
    const match = /^fake\*([A-Za-z0-9_-]+)~2$/.exec(sealed)!;
    return (JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as { sid: string })
      .sid;
  }

  const countUsers = (email: string) =>
    t.db.withIdentity({ email }, async (tx) => {
      const { rows } = await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM users WHERE email = ${email}`.execute(tx);
      return rows[0]!.n;
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    // a.owner is in two arenas: A (owner fixture) and B (plain member).
    await t.db.withSystemJob({ orgId: b.orgId }, async (tx) => {
      await sql`INSERT INTO org_memberships (org_id, user_id) VALUES (${b.orgId}, ${a.users.owner})`.execute(
        tx,
      );
    });
    fake = new FakeIdentityProvider();
    fake.now = () => now;
    log = memoryLog();
    app = await createApp({
      db: t.db,
      logger: log.logger,
      clock: () => now,
      webOrigin: WEB,
      auth: { provider: fake, cookiePassword: COOKIE_PASSWORD, secureCookies: true },
    });
  });

  afterAll(async () => {
    await app?.close();
    await t?.cleanup();
  });

  beforeEach(() => {
    // Each test starts a fresh minute, so rate-limit windows never carry over.
    now += 10 * MIN;
  });

  describe('GET /auth/login', () => {
    it('302s to the hosted login with state and a PKCE challenge, and sets the state cookie', async () => {
      const { res, state, login, location } = await startLogin();
      expect(location.origin).toBe('https://auth.example.test');
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(attr(login, 'HttpOnly')).toBe(true);
      expect(attr(login, 'SameSite')).toBe('Lax');
      expect(attr(login, 'Secure')).toBe(true);
      expect(attr(login, 'Path')).toBe('/v1/auth');
      expect(attr(login, 'Max-Age')).toBe('600');
      // The cookie is encrypted: neither the state nor anything readable is in it.
      expect(login.value).not.toContain(state);
      const again = await startLogin();
      expect(again.state).not.toBe(state);
    });
  });

  describe('GET /auth/callback', () => {
    it('creates the account, sets the session and CSRF cookies, and 302s to return_to', async () => {
      const email = `new-${randomUUID()}@signup.test`;
      const res = await callback(profile(email), { returnTo: '/arenas?x=1' });
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${WEB}/arenas?x=1`);
      const cookies = setCookies(res);
      const session = cookies.get('saras_session');
      const csrf = cookies.get('saras_csrf');
      expect(session?.value).toMatch(/^s1\./);
      expect(attr(session, 'HttpOnly')).toBe(true);
      expect(attr(session, 'SameSite')).toBe('Lax');
      expect(attr(session, 'Secure')).toBe(true);
      expect(attr(session, 'Path')).toBe('/');
      expect(attr(session, 'Max-Age')).toBe(String(12 * 60 * 60));
      expect(csrf?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(attr(csrf, 'HttpOnly')).toBeUndefined();
      expect(attr(csrf, 'SameSite')).toBe('Lax');
      expect(attr(csrf, 'Secure')).toBe(true);
      expect(isCleared(cookies.get('saras_login'))).toBe(true);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(await countUsers(email)).toBe(1);
      secrets.add(session!.value);
      secrets.add(csrf!.value);

      const me = await http().get('/v1/me').set('Cookie', `saras_session=${session!.value}`);
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({ email, display_name: 'Priya K', orgs: [], unit_roles: [] });
      expect(me.body.handle).toMatch(/^new-[0-9a-f-]+$/);
    });

    it('a second login finds the same account (no duplicate), matching the email case-insensitively', async () => {
      const email = `again-${randomUUID()}@signup.test`;
      const first = await signIn(email);
      const second = await signIn(email.toUpperCase());
      expect(second.userId).toBe(first.userId);
      expect(await countUsers(email)).toBe(1);
    });

    it('an existing account (invited teammate) signs in to that account', async () => {
      const session = await signIn(a.emails.member);
      expect(session.userId).toBe(a.users.member);
    });

    it('gives a new account a unique handle when the base is taken', async () => {
      const first = await signIn(`dup.handle@one-${randomUUID()}.test`);
      const second = await signIn(`dup.handle@two-${randomUUID()}.test`);
      const handles = await Promise.all(
        [first, second].map(async (s) => {
          const res = await http().get('/v1/me').set('Cookie', `saras_session=${s.session}`);
          return res.body.handle as string;
        }),
      );
      expect(new Set(handles).size).toBe(2);
      for (const handle of handles) expect(handle).toMatch(/^dup-handle(-[a-z0-9]{4})?$/);
    });

    it.each<[string, { state?: string | null; cookie?: boolean }]>([
      ['a state that does not match', { state: 'wrong' }],
      ['no state parameter', { state: null }],
      ['no state cookie', { cookie: false }],
    ])('%s → 302 auth_error=invalid_state, no session, code not used', async (_l, opts) => {
      const { state, login } = await startLogin();
      const code = `code-${randomUUID()}`;
      secrets.add(code);
      fake.codes.set(code, profile(`state-${randomUUID()}@signup.test`));
      const query =
        opts.state === null ? `code=${code}` : `code=${code}&state=${opts.state ?? state}`;
      let req = http().get(`/v1/auth/callback?${query}`);
      if (opts.cookie !== false) req = req.set('Cookie', `saras_login=${login.value}`);
      const res = await req;
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);
      expect(setCookies(res).has('saras_session')).toBe(false);
      expect(fake.codes.has(code)).toBe(true);
      expect(res.text).not.toContain(code);
    });

    it('rejects an expired login state (10 min)', async () => {
      const { state, login } = await startLogin();
      now += 11 * MIN;
      const res = await http()
        .get(`/v1/auth/callback?code=c&state=${state}`)
        .set('Cookie', `saras_login=${login.value}`);
      expect(res.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);
    });

    it('a tampered state cookie is rejected', async () => {
      const { state, login } = await startLogin();
      const tampered = login.value.slice(0, -3) + (login.value.endsWith('AAA') ? 'BBB' : 'AAA');
      const res = await http()
        .get(`/v1/auth/callback?code=c&state=${state}`)
        .set('Cookie', `saras_login=${tampered}`);
      expect(res.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);
    });

    it('a missing or rejected code → auth_error=invalid_code', async () => {
      const first = await startLogin();
      const missing = await http()
        .get(`/v1/auth/callback?state=${first.state}`)
        .set('Cookie', `saras_login=${first.login.value}`);
      expect(missing.headers.location).toBe(`${WEB}/?auth_error=invalid_code`);

      const second = await startLogin();
      const unknown = await http()
        .get(`/v1/auth/callback?code=CODE-NOT-ISSUED&state=${second.state}`)
        .set('Cookie', `saras_login=${second.login.value}`);
      secrets.add('CODE-NOT-ISSUED');
      expect(unknown.headers.location).toBe(`${WEB}/?auth_error=invalid_code`);
      expect(setCookies(unknown).has('saras_session')).toBe(false);
    });

    it('a provider error (user cancelled) → auth_error=denied', async () => {
      const { state, login } = await startLogin();
      const res = await http()
        .get(`/v1/auth/callback?error=access_denied&state=${state}`)
        .set('Cookie', `saras_login=${login.value}`);
      expect(res.headers.location).toBe(`${WEB}/?auth_error=denied`);
    });

    it('an unverified email → no account, no session, provider session revoked', async () => {
      const email = `unverified-${randomUUID()}@signup.test`;
      const revokedBefore = fake.revoked.length;
      const res = await callback(profile(email, { emailVerified: false }));
      expect(res.headers.location).toBe(`${WEB}/?auth_error=email_unverified`);
      expect(setCookies(res).has('saras_session')).toBe(false);
      expect(await countUsers(email)).toBe(0);
      expect(fake.revoked.length).toBe(revokedBefore + 1);
    });

    it('a deactivated account → auth_error=account_deactivated, no session', async () => {
      const fixture = await createTenantFixture(t.db, 'deact');
      await t.db.withSystemJob({ orgId: fixture.orgId }, (tx) =>
        sql`UPDATE users SET deactivated_at = now() WHERE id = ${fixture.users.member}`.execute(tx),
      );
      const res = await callback(profile(fixture.emails.member));
      expect(res.headers.location).toBe(`${WEB}/?auth_error=account_deactivated`);
      expect(setCookies(res).has('saras_session')).toBe(false);
    });

    it.each(['https://evil.example', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)'])(
      'ignores return_to=%s (no open redirect)',
      async (returnTo) => {
        const res = await callback(profile(`redir-${randomUUID()}@signup.test`), { returnTo });
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(`${WEB}/`);
      },
    );

    it('a failed callback leaves an existing session alone', async () => {
      const s = await signIn(`keep-${randomUUID()}@signup.test`);
      const res = await http()
        .get('/v1/auth/callback?code=x&state=y')
        .set('Cookie', `${s.cookie}; saras_login=garbage`);
      expect(res.headers.location).toBe(`${WEB}/?auth_error=invalid_state`);
      expect(setCookies(res).has('saras_session')).toBe(false);
      expect((await http().get('/v1/me').set('Cookie', s.cookie)).status).toBe(200);
    });
  });

  describe('session cookie', () => {
    it('GET /me returns the contract shape', async () => {
      const s = await signIn(a.emails.owner);
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const me = MeSchema.parse(res.body);
      expect(me).toMatchObject({ id: a.users.owner, email: a.emails.owner, unit_roles: [] });
      expect(res.body).not.toHaveProperty('personal_agent');
      expect(res.headers['ratelimit-limit']).toBeDefined();
    });

    it('no cookie → 401', async () => {
      expectProblem(await http().get('/v1/me'), 401, 'UNAUTHENTICATED');
    });

    const flipMac = (v: string): string => {
      const [p, meta, mac, ...rest] = v.split('.');
      const first = mac!.charAt(0) === 'A' ? 'B' : 'A';
      return [p, meta, first + mac!.slice(1), ...rest].join('.');
    };
    const forgeIssueTime = (v: string): string => {
      const [p, meta, mac, ...rest] = v.split('.');
      const m = JSON.parse(Buffer.from(meta!, 'base64url').toString()) as { iat: number };
      const forged = Buffer.from(JSON.stringify({ ...m, iat: m.iat + H })).toString('base64url');
      return [p, forged, mac, ...rest].join('.');
    };
    it.each([
      ['a flipped MAC character', flipMac],
      ['a forged issue time', forgeIssueTime],
      ['garbage', (): string => 'not-a-session'],
    ])('a tampered cookie (%s) → 401 and both cookies cleared', async (_l, tamper) => {
      const s = await signIn(`tamper-${randomUUID()}@signup.test`);
      const res = await http()
        .get('/v1/me')
        .set('Cookie', `saras_session=${tamper(s.session)}`);
      expectProblem(res, 401, 'UNAUTHENTICATED');
      const cookies = setCookies(res);
      expect(isCleared(cookies.get('saras_session'))).toBe(true);
      expect(isCleared(cookies.get('saras_csrf'))).toBe(true);
    });

    it('2 h idle → 401 and cookies cleared', async () => {
      const s = await signIn(`idle-${randomUUID()}@signup.test`);
      now += 2 * H;
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      expectProblem(res, 401, 'UNAUTHENTICATED');
      expect(isCleared(setCookies(res).get('saras_session'))).toBe(true);
    });

    it('activity keeps the session alive, but 12 h after sign-in it ends', async () => {
      const s = await signIn(`absolute-${randomUUID()}@signup.test`);
      const start = now;
      let cookie = s.cookie;
      for (let hour = 1; hour < 12; hour++) {
        now = start + hour * H;
        const res = await http().get('/v1/me').set('Cookie', cookie);
        expect(res.status, `hour ${hour}`).toBe(200);
        const next = setCookies(res).get('saras_session');
        expect(next, `hour ${hour}: re-issued`).toBeDefined();
        secrets.add(next!.value);
        // Max-Age counts down to the absolute limit.
        expect(Number(attr(next, 'Max-Age'))).toBe((12 - hour) * 60 * 60);
        cookie = `saras_session=${next!.value}; saras_csrf=${s.csrf}`;
      }
      now = start + 12 * H;
      const res = await http().get('/v1/me').set('Cookie', cookie);
      expectProblem(res, 401, 'UNAUTHENTICATED');
      expect(isCleared(setCookies(res).get('saras_session'))).toBe(true);
    });

    it('re-issues `seen` at most every 5 min', async () => {
      const s = await signIn(`touch-${randomUUID()}@signup.test`);
      now += 1 * MIN;
      const quiet = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(quiet.status).toBe(200);
      expect(setCookies(quiet).has('saras_session')).toBe(false);
    });

    it('an expired access token is refreshed once and the cookie re-set', async () => {
      const s = await signIn(`refresh-${randomUUID()}@signup.test`);
      const before = fake.refreshes;
      now += 6 * MIN;
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(res.status).toBe(200);
      const next = setCookies(res).get('saras_session');
      expect(next?.value).toMatch(/^s1\./);
      expect(next?.value).not.toBe(s.session);
      expect(attr(next, 'HttpOnly')).toBe(true);
      expect(fake.refreshes).toBe(before + 1);
      secrets.add(next!.value);
      // The CSRF token belongs to the login, not to the access token: unchanged.
      expect(setCookies(res).get('saras_csrf')?.value).toBe(s.csrf);

      const after = await http().get('/v1/me').set('Cookie', `saras_session=${next!.value}`);
      expect(after.status).toBe(200);
      expect(fake.refreshes).toBe(before + 1);
    });

    it('concurrent requests with an expired access token share one refresh', async () => {
      const s = await signIn(`burst-${randomUUID()}@signup.test`);
      const before = fake.refreshes;
      now += 6 * MIN;
      const results = await Promise.all(
        [1, 2, 3].map(() => http().get('/v1/me').set('Cookie', s.cookie)),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(fake.refreshes).toBe(before + 1);
    });

    it('an account deactivated after sign-in → 401', async () => {
      const fixture = await createTenantFixture(t.db, 'late');
      const s = await signIn(fixture.emails.observer);
      await t.db.withSystemJob({ orgId: fixture.orgId }, (tx) =>
        sql`UPDATE users SET deactivated_at = now() WHERE id = ${fixture.users.observer}`.execute(
          tx,
        ),
      );
      expectProblem(await http().get('/v1/me').set('Cookie', s.cookie), 401, 'UNAUTHENTICATED');
    });
  });

  describe('CSRF (double-submit token bound to the session)', () => {
    const patch = (cookie: string, csrf?: string) => {
      const req = http().patch('/v1/me').set('Cookie', cookie).send({ display_name: 'Changed' });
      return csrf === undefined ? req : req.set('X-CSRF-Token', csrf);
    };

    it('PATCH without the header → 403 FORBIDDEN with a request id, nothing changed', async () => {
      const s = await signIn(`csrf-${randomUUID()}@signup.test`);
      const problem = expectProblem(await patch(s.cookie), 403, 'FORBIDDEN');
      expect(problem.detail).toMatch(/X-CSRF-Token/);
      const me = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(me.body.display_name).toBe('Priya K');
    });

    it('a mismatched token, or another session’s token, → 403', async () => {
      const s = await signIn(`csrf2-${randomUUID()}@signup.test`);
      const other = await signIn(`csrf3-${randomUUID()}@signup.test`);
      expectProblem(await patch(s.cookie, 'x'.repeat(43)), 403, 'FORBIDDEN');
      // A planted saras_csrf cookie does not help: the header must match the session's own token.
      expectProblem(
        await patch(`saras_session=${s.session}; saras_csrf=${other.csrf}`, other.csrf),
        403,
        'FORBIDDEN',
      );
    });

    it('the matching token → 200', async () => {
      const s = await signIn(`csrf4-${randomUUID()}@signup.test`);
      const res = await patch(s.cookie, s.csrf);
      expect(res.status).toBe(200);
      expect(res.body.display_name).toBe('Changed');
    });

    it('an invalid session is 401 before CSRF is considered', async () => {
      expectProblem(
        await http().patch('/v1/me').set('Cookie', 'saras_session=bogus').send({}),
        401,
        'UNAUTHENTICATED',
      );
    });
  });

  describe('/me privacy', () => {
    it('lists exactly your own arenas, with your role and status', async () => {
      const s = await signIn(a.emails.owner);
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      const orgs = (res.body.orgs as { org: { id: string }; role: string; status: string }[]).map(
        (o) => [o.org.id, o.role, o.status],
      );
      expect(orgs.sort()).toEqual(
        [
          [a.orgId, 'member', 'active'],
          [b.orgId, 'member', 'active'],
        ].sort(),
      );
      expect(JSON.stringify(res.body)).not.toContain(a.emails.member);
    });

    it('another user sees only their own arena, and nobody else’s profile', async () => {
      const s = await signIn(b.emails.member);
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(res.body.id).toBe(b.users.member);
      expect(res.body.orgs.map((o: { org: { id: string } }) => o.org.id)).toEqual([b.orgId]);
      expect(JSON.stringify(res.body)).not.toContain(a.emails.owner);
    });

    it('a suspended membership is not listed', async () => {
      const fixture = await createTenantFixture(t.db, 'susp');
      await t.db.withSystemJob({ orgId: fixture.orgId }, (tx) =>
        sql`UPDATE org_memberships SET status = 'suspended'
            WHERE org_id = ${fixture.orgId} AND user_id = ${fixture.users.outsider}`.execute(tx),
      );
      const s = await signIn(fixture.emails.outsider);
      const res = await http().get('/v1/me').set('Cookie', s.cookie);
      expect(res.body.orgs).toEqual([]);
    });
  });

  describe('PATCH /me', () => {
    it('updates only the caller', async () => {
      const s = await signIn(a.emails.observer);
      const handle = `obs-${randomUUID().slice(0, 8)}`;
      const res = await http()
        .patch('/v1/me')
        .set('Cookie', s.cookie)
        .set('X-CSRF-Token', s.csrf)
        .send({ display_name: '  Olu  ', handle: handle.toUpperCase() });
      expect(res.status).toBe(200);
      expect(MeSchema.parse(res.body)).toMatchObject({
        id: a.users.observer,
        display_name: 'Olu',
        handle,
      });
      const others = await t.db.withSystemJob({ orgId: a.orgId }, async (tx) => {
        const { rows } = await sql<{ display_name: string }>`
          SELECT display_name FROM users WHERE id IN (${a.users.member}, ${a.users.outsider})`.execute(
          tx,
        );
        return rows.map((r) => r.display_name).sort();
      });
      expect(others).toEqual(['member', 'outsider']);
    });

    it('a taken handle → 409 ALREADY_EXISTS (case-insensitive)', async () => {
      const s = await signIn(a.emails.outsider);
      const holder = await signIn(b.emails.owner);
      const taken = await http().get('/v1/me').set('Cookie', holder.cookie);
      const res = await http()
        .patch('/v1/me')
        .set('Cookie', s.cookie)
        .set('X-CSRF-Token', s.csrf)
        .send({ handle: (taken.body.handle as string).toUpperCase() });
      expectProblem(res, 409, 'ALREADY_EXISTS');
    });

    it.each([
      [{}, 'body'],
      [{ handle: 'no' }, 'handle'],
      [{ handle: 'bad handle!' }, 'handle'],
      [{ display_name: '' }, 'display_name'],
      [{ email: 'x@y.z' }, 'body'],
    ])('invalid body %j → 400 VALIDATION_FAILED', async (body, field) => {
      const s = await signIn(`patch-${randomUUID()}@signup.test`);
      const res = await http()
        .patch('/v1/me')
        .set('Cookie', s.cookie)
        .set('X-CSRF-Token', s.csrf)
        .send(body);
      const problem = expectProblem(res, 400, 'VALIDATION_FAILED');
      expect(problem.errors?.[0]?.field).toBe(field);
    });
  });

  describe('POST /auth/logout', () => {
    it('needs the CSRF header', async () => {
      const s = await signIn(`logout-csrf-${randomUUID()}@signup.test`);
      expectProblem(await http().post('/v1/auth/logout').set('Cookie', s.cookie), 403, 'FORBIDDEN');
      expect((await http().get('/v1/me').set('Cookie', s.cookie)).status).toBe(200);
    });

    it('without a session → 401', async () => {
      expectProblem(await http().post('/v1/auth/logout'), 401, 'UNAUTHENTICATED');
    });

    it('204, revokes the provider session, clears the cookies, and the old cookie stops working', async () => {
      const s = await signIn(`logout-${randomUUID()}@signup.test`);
      const res = await http()
        .post('/v1/auth/logout')
        .set('Cookie', s.cookie)
        .set('X-CSRF-Token', s.csrf);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const cookies = setCookies(res);
      expect(isCleared(cookies.get('saras_session'))).toBe(true);
      expect(isCleared(cookies.get('saras_csrf'))).toBe(true);
      expect(fake.revoked).toContain(s.sessionId);
      // The access token inside is still "valid" for the provider; the API rejects it anyway.
      expectProblem(await http().get('/v1/me').set('Cookie', s.cookie), 401, 'UNAUTHENTICATED');
      // And once the access token expires, refresh fails at the provider too.
      now += 6 * MIN;
      expectProblem(await http().get('/v1/me').set('Cookie', s.cookie), 401, 'UNAUTHENTICATED');
    });
  });

  describe('CORS', () => {
    it('allows the web origin with credentials and the CSRF header', async () => {
      const res = await http()
        .options('/v1/me')
        .set('Origin', WEB)
        .set('Access-Control-Request-Method', 'PATCH')
        .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(WEB);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-allow-headers']).toMatch(/X-CSRF-Token/i);
      const simple = await http().get('/v1/health').set('Origin', WEB);
      expect(simple.headers['access-control-expose-headers']).toMatch(/X-Request-Id/);
      expect(simple.headers['access-control-expose-headers']).toMatch(/RateLimit-Remaining/);
    });

    it('never reflects another origin', async () => {
      const res = await http()
        .options('/v1/me')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'PATCH');
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });
  });

  describe('without WorkOS configuration', () => {
    it('has no /auth routes and every authenticated route answers 401', async () => {
      const bare = await createApp({ db: t.db, logger: memoryLog().logger });
      try {
        const server = bare.getHttpServer();
        expectProblem(await request(server).get('/v1/auth/login'), 404, 'NOT_FOUND');
        expectProblem(
          await request(server).get('/v1/me').set('Cookie', 'saras_session=anything'),
          401,
          'UNAUTHENTICATED',
        );
      } finally {
        await bare.close();
      }
    });
  });

  describe('logging', () => {
    it('never logs session cookies, CSRF tokens, codes, state or provider sessions', () => {
      const out = log.lines.join('');
      expect(log.lines.length).toBeGreaterThan(20);
      expect(secrets.size).toBeGreaterThan(20);
      for (const secret of secrets) {
        expect(out).not.toContain(secret);
        // The sealed provider session inside the envelope, too.
        const sealed = decodeURIComponent(secret).split('.').slice(3).join('.');
        if (sealed) expect(out).not.toContain(sealed);
      }
      // The callback is logged by route template, never with its query string.
      expect(out).toContain('/v1/auth/callback');
      expect(out).not.toContain('code=');
      expect(out).not.toContain('state=');
    });
  });
});
