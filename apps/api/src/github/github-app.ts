import { createHmac, createPrivateKey, sign, timingSafeEqual, type KeyObject } from 'node:crypto';
import type { Clock } from '../pipeline/tokens.js';

// The ParallelFlow GitHub App (ADR-040): app authentication, installation tokens, webhook
// signatures, signed `state` values and a small REST client over fetch.
//   app JWT              RS256, iss = app id, 9 minutes, signed with the app's private key
//   installation token   POST /app/installations/{id}/access_tokens, limited to the one repository
//                        and to contents, pull requests and metadata (metadata only to list the
//                        installation's repositories); cached in memory until five
//                        minutes before it expires. Never stored, never logged.
//   webhook              X-Hub-Signature-256 = sha256=HMAC-SHA256(secret, raw body), compared in
//                        constant time
//   state / grant        base64url(JSON) "." base64url(HMAC-SHA256), with a kind and an expiry,
//                        bound to the person and the arena

/** GITHUB_APP_* and GITHUB_WEBHOOK_SECRET (config.ts). Unset = GitHub is off. */
export interface GithubAppConfig {
  appId: string;
  slug: string;
  /** PEM. */
  privateKey: string;
  webhookSecret: string;
  /** The app's OAuth client: proves the person can use the installation they picked. */
  clientId: string;
  clientSecret: string;
}

const API = 'https://api.github.com';
const WEB = 'https://github.com';
/** Tokens are renewed this long before GitHub's expiry. */
export const TOKEN_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** A GitHub App JWT (RS256), valid from a minute ago (clock drift) for nine minutes. */
export function appJwt(appId: string, key: KeyObject | string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), key);
  return `${head}.${body}.${b64url(signature)}`;
}

/** Whether `header` (X-Hub-Signature-256) signs `body` with `secret`. Constant time. */
export function verifyWebhookSignature(
  secret: string,
  body: Buffer,
  header: string | undefined,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  const expected = createHmac('sha256', secret).update(body).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Signed, expiring values handed to the browser and GitHub (`state`, the repo-choice grant). */
export class SignedValues {
  constructor(
    private readonly key: Buffer,
    private readonly clock: Clock,
  ) {}

  private mac(data: string): Buffer {
    return createHmac('sha256', this.key).update(data).digest();
  }

  sign(kind: string, payload: Record<string, unknown>, ttlMs: number): string {
    const data = b64url(JSON.stringify({ ...payload, k: kind, x: this.clock() + ttlMs }));
    return `${data}.${b64url(this.mac(data))}`;
  }

  /** The payload, or null when the value is forged, of another kind or expired. */
  verify(kind: string, value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'string' || value.length > 4000) return null;
    const [data = '', mac = '', extra] = value.split('.');
    if (!data || !mac || extra !== undefined) return null;
    const given = Buffer.from(mac, 'base64url');
    const expected = this.mac(data);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null) return null;
    const p = payload as Record<string, unknown>;
    if (p.k !== kind || typeof p.x !== 'number' || p.x <= this.clock()) return null;
    return p;
  }
}

/** A GitHub API call that failed; `status` only (no body is kept: it may echo secrets). */
export class GithubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub answered ${status}`);
    this.name = 'GithubApiError';
  }
}

export interface MintedToken {
  token: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * Installation tokens per (installation, repository), minted on demand and kept in memory until
 * TOKEN_MARGIN_MS before they expire. Concurrent requests share one mint.
 */
export class InstallationTokens {
  private readonly cache = new Map<string, MintedToken>();
  private readonly pending = new Map<string, Promise<MintedToken>>();

  constructor(
    private readonly mint: (installationId: number, repoId: number | null) => Promise<MintedToken>,
    private readonly clock: Clock,
  ) {}

  async get(installationId: number, repoId: number | null): Promise<string> {
    const key = `${installationId}:${repoId ?? '*'}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - TOKEN_MARGIN_MS > this.clock()) return cached.token;
    let minting = this.pending.get(key);
    if (!minting) {
      minting = this.mint(installationId, repoId).finally(() => this.pending.delete(key));
      this.pending.set(key, minting);
    }
    const minted = await minting;
    this.cache.set(key, minted);
    return minted.token;
  }

  /** Drops an installation's tokens (uninstalled or suspended). */
  forget(installationId: number): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${installationId}:`)) this.cache.delete(key);
    }
  }
}

export interface GithubRepoInfo {
  id: number;
  name: string;
  owner: string;
  full_name: string;
  private: boolean;
  default_branch: string;
}

interface RawRepo {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  private?: unknown;
  default_branch?: unknown;
  owner?: { login?: unknown };
}

function repoInfo(raw: RawRepo): GithubRepoInfo | null {
  const { id, name, full_name: fullName, default_branch: branch } = raw;
  const owner = raw.owner?.login;
  if (typeof id !== 'number' || typeof name !== 'string' || typeof owner !== 'string') return null;
  return {
    id,
    name,
    owner,
    full_name: typeof fullName === 'string' ? fullName : `${owner}/${name}`,
    private: raw.private === true,
    default_branch: typeof branch === 'string' && branch ? branch : 'main',
  };
}

export type FetchFn = typeof fetch;

/** The few GitHub REST calls ParallelFlow makes, as the app, an installation or a person. */
export class GithubClient {
  private readonly key: KeyObject;
  readonly tokens: InstallationTokens;

  constructor(
    readonly config: GithubAppConfig,
    private readonly clock: Clock,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.key = createPrivateKey(config.privateKey);
    this.tokens = new InstallationTokens((i, r) => this.mintToken(i, r), clock);
  }

  /** https://github.com/apps/<slug>/installations/new?state=… */
  installUrl(state: string): string {
    const url = new URL(`${WEB}/apps/${encodeURIComponent(this.config.slug)}/installations/new`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** GitHub's OAuth page for the app (returns to the app's Callback URL with `code`). */
  authorizeUrl(state: string): string {
    const url = new URL(`${WEB}/login/oauth/authorize`);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('state', state);
    return url.toString();
  }

  private async call(url: string, init: RequestInit & { auth?: string }): Promise<unknown> {
    const { auth, ...rest } = init;
    const res = await this.fetchFn(url, {
      ...rest,
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'ParallelFlow',
        ...(auth && { authorization: auth }),
        ...(rest.body !== undefined && { 'content-type': 'application/json' }),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new GithubApiError(res.status);
    return res.json();
  }

  private async mintToken(installationId: number, repoId: number | null): Promise<MintedToken> {
    const body = await this.call(`${API}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: `Bearer ${appJwt(this.config.appId, this.key, this.clock())}`,
      body: JSON.stringify({
        ...(repoId !== null && { repository_ids: [repoId] }),
        // Listing an installation's repositories (no repo) needs metadata only.
        permissions:
          repoId === null
            ? { metadata: 'read' }
            : { contents: 'write', pull_requests: 'write', metadata: 'read' },
      }),
    });
    const { token, expires_at: expiresAt } = (body ?? {}) as Record<string, unknown>;
    const at = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || Number.isNaN(at)) throw new GithubApiError(502);
    return { token, expiresAt: at };
  }

  /** Exchanges the OAuth `code` for the person's token (used once, then dropped). */
  async userToken(code: string): Promise<string> {
    const body = await this.call(`${WEB}/login/oauth/access_token`, {
      method: 'POST',
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
      }),
    });
    const token = (body as Record<string, unknown> | null)?.access_token;
    if (typeof token !== 'string') throw new GithubApiError(401);
    return token;
  }

  /** Repositories of an installation the person can access (404/403 when they cannot). */
  async userInstallationRepos(userToken: string, installationId: number): Promise<number[]> {
    const body = await this.call(
      `${API}/user/installations/${installationId}/repositories?per_page=100`,
      { method: 'GET', auth: `Bearer ${userToken}` },
    );
    const repos = (body as { repositories?: RawRepo[] } | null)?.repositories ?? [];
    return repos.flatMap((r) => (typeof r.id === 'number' ? [r.id] : []));
  }

  /** Repositories the installation was given. */
  async installationRepos(installationId: number): Promise<GithubRepoInfo[]> {
    const token = await this.tokens.get(installationId, null);
    const body = await this.call(`${API}/installation/repositories?per_page=100`, {
      method: 'GET',
      auth: `Bearer ${token}`,
    });
    const repos = (body as { repositories?: RawRepo[] } | null)?.repositories ?? [];
    return repos.flatMap((r) => repoInfo(r) ?? []);
  }

  /** One repository, as the installation sees it. */
  async repo(installationId: number, repoId: number): Promise<GithubRepoInfo> {
    const token = await this.tokens.get(installationId, repoId);
    const body = await this.call(`${API}/repositories/${repoId}`, {
      method: 'GET',
      auth: `Bearer ${token}`,
    });
    const info = repoInfo((body ?? {}) as RawRepo);
    if (!info) throw new GithubApiError(502);
    return info;
  }
}
