import { createHash } from 'node:crypto';
import type { Database } from '@saras/db';
import type { Logger } from '@saras/observability';
import type { CookiePolicy } from './cookies.js';
import type { AuthKeys } from './crypto.js';
import type { IdentityProvider, SessionRefresh } from './identity-provider.js';
import type { SessionLimits } from './session.js';

// Shared state of the web session: built once in createApp, used by the session verifier (every
// request) and the auth controller (login, callback, logout).

export interface WebSessionDeps {
  db: Database;
  provider: IdentityProvider;
  keys: AuthKeys;
  cookies: CookiePolicy;
  limits: SessionLimits;
  webOrigin: string;
  clock: () => number;
  logger: Logger;
  revoked: RevokedSessions;
  refreshes: RefreshCoalescer;
}

/**
 * Sessions ended by logout in this process. WorkOS access tokens are verified locally, so a copied
 * cookie would otherwise keep working until its access token expires (WorkOS default 5 min); after
 * that, refresh fails because the session is revoked at WorkOS. In-memory only: other API instances
 * do not see it (SLICE_DEBT: move to Redis with the realtime story).
 */
export class RevokedSessions {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxEntries = 10_000,
  ) {}

  add(sessionId: string, now: number): void {
    this.prune(now);
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(sessionId, now + this.ttlMs);
  }

  has(sessionId: string, now: number): boolean {
    const until = this.entries.get(sessionId);
    return until !== undefined && until > now;
  }

  private prune(now: number): void {
    for (const [id, until] of this.entries) {
      if (until <= now) this.entries.delete(id);
    }
  }
}

/**
 * Refresh tokens are single-use. When the access token expires, a browser often sends several
 * requests at once with the same cookie; they share one refresh, and its result is reused for a
 * short while so late requests carrying the old cookie still succeed. Per process only.
 */
export class RefreshCoalescer {
  private readonly inflight = new Map<string, { result: Promise<SessionRefresh>; until: number }>();

  constructor(private readonly reuseMs = 30_000) {}

  run(
    sealed: string,
    now: number,
    refresh: (sealed: string) => Promise<SessionRefresh>,
  ): Promise<SessionRefresh> {
    for (const [key, entry] of this.inflight) {
      if (entry.until <= now) this.inflight.delete(key);
    }
    const key = createHash('sha256').update(sealed).digest('base64url');
    const existing = this.inflight.get(key);
    if (existing) return existing.result;
    const result = refresh(sealed);
    this.inflight.set(key, { result, until: now + this.reuseMs });
    // Failures are not reused: the next request tries again.
    result.then(
      (r) => {
        if (r.status !== 'refreshed') this.inflight.delete(key);
      },
      () => this.inflight.delete(key),
    );
    return result;
  }
}
