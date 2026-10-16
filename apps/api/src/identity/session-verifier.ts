import { createHash } from 'node:crypto';
import type { Database } from '@saras/db';
import type { Request, Response } from 'express';
import type { SessionVerifier } from '../pipeline/auth.js';
import { ApiError } from '../pipeline/errors.js';
import type { Principal } from '../pipeline/request-context.js';
import {
  clearSessionCookies,
  CSRF_HEADER,
  readCookie,
  SESSION_COOKIE,
  setSessionCookies,
} from './cookies.js';
import { csrfRequired, csrfValid } from './csrf.js';
import type { IdpSession } from './identity-provider.js';
import { checkAge, decodeSession, encodeSession } from './session.js';
import type { WebSessionDeps } from './web-session.js';

// The production SessionVerifier (doc 05 §5.5 step 2): the `saras_session` cookie from WorkOS AuthKit.
//
//   1. envelope: MAC valid (else 401: tampered or from another key)
//   2. age: 12 h absolute, 2 h idle (doc 10 §10.3)
//   3. WorkOS: access token verified locally; expired → refresh once, re-set the cookie
//   4. not revoked by logout in this process; email still verified
//   5. account: exists, not deactivated, same email as the WorkOS session (user scope)
//   6. touch: re-issue `seen` (throttled) or the refreshed session
//   7. CSRF: unsafe methods need X-CSRF-Token = the session's token (else 403 FORBIDDEN)
//
// Any failure in 1–5 clears both cookies and answers 401. Nothing here logs cookie values, tokens
// or provider errors; the access log records the 401 / 403 code only.

/** How long a verified account (exists, not deactivated, same email) is trusted without a lookup. */
export const ACCOUNT_CHECK_TTL_MS = 30_000;
const ACCOUNT_CACHE_MAX = 10_000;

/**
 * Step 5 with a short in-memory cache, so a signed-in request does not pay a database transaction
 * (several round trips to a remote database) just to re-read its own account. Only positive results
 * are cached, for ACCOUNT_CHECK_TTL_MS, keyed by a SHA-256 of session id, user id and email (never a
 * cookie value). Logout is unaffected (the revocation list is checked before this); a deactivated
 * account or changed email takes effect within the TTL (SLICE_DEBT.md).
 */
export class AccountCheck {
  private readonly verified = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly clock: () => number = Date.now,
    private readonly ttlMs = ACCOUNT_CHECK_TTL_MS,
  ) {}

  async check(uid: string, email: string, sessionId = ''): Promise<boolean> {
    const wanted = email.trim().toLowerCase();
    const key = createHash('sha256')
      .update(JSON.stringify([sessionId, uid, wanted]))
      .digest('hex');
    const now = this.clock();
    const until = this.verified.get(key);
    if (until !== undefined && until > now) return true;
    this.verified.delete(key);

    const account = await this.db.withUser({ userId: uid }, (tx) =>
      tx
        .selectFrom('users')
        .select(['email', 'deactivated_at'])
        .where('id', '=', uid)
        .executeTakeFirst(),
    );
    const ok = Boolean(
      account && !account.deactivated_at && account.email.toLowerCase() === wanted,
    );
    if (ok) {
      if (this.verified.size >= ACCOUNT_CACHE_MAX) this.verified.clear();
      this.verified.set(key, now + this.ttlMs);
    }
    return ok;
  }
}

export class WorkosSessionVerifier implements SessionVerifier {
  private readonly accounts: AccountCheck;

  constructor(private readonly deps: WebSessionDeps) {
    this.accounts = new AccountCheck(deps.db, deps.clock);
  }

  async verify(req: Request, res: Response): Promise<Principal | null> {
    const raw = readCookie(req, SESSION_COOKIE);
    if (!raw) return null;
    const { keys, cookies, limits, clock, provider, revoked } = this.deps;
    const signOut = (): null => {
      clearSessionCookies(res, cookies);
      return null;
    };

    const decoded = decodeSession(keys.sessionMac, raw);
    if (!decoded) return signOut();
    const now = clock();
    const age = checkAge(decoded.meta, now, limits);
    if (!age.ok) return signOut();

    let sealed = decoded.sealed;
    let reissue = age.touch;
    let session: IdpSession;
    const check = await provider.authenticate(sealed);
    if (check.status === 'valid') {
      session = check;
    } else if (check.status === 'expired') {
      const refreshed = await this.deps.refreshes.run(sealed, now, (s) => provider.refresh(s));
      // The provider is down: keep the cookie, fail this request (500), let the client retry.
      if (refreshed.status === 'unavailable') throw new Error('Identity provider unavailable');
      if (refreshed.status === 'ended') return signOut();
      session = refreshed;
      sealed = refreshed.sealedSession;
      reissue = true;
    } else {
      return signOut();
    }
    if (revoked.has(session.sessionId, now) || !session.user.emailVerified) return signOut();

    const { uid, csrf } = decoded.meta;
    if (!(await this.accounts.check(uid, session.user.email, session.sessionId))) return signOut();

    // Before the CSRF check: a refreshed session must reach the browser even if this request fails,
    // because the old refresh token is now used up.
    if (reissue) {
      setSessionCookies(res, cookies, {
        value: encodeSession(keys.sessionMac, { ...decoded.meta, seen: now }, sealed),
        csrf,
        maxAgeMs: age.remainingMs,
      });
    }

    if (csrfRequired(req.method) && !csrfValid(req.headers[CSRF_HEADER.toLowerCase()], csrf)) {
      throw new ApiError(403, 'FORBIDDEN', {
        detail: `Send the ${CSRF_HEADER} header with the value of the saras_csrf cookie.`,
      });
    }
    return { userId: uid, sessionId: session.sessionId };
  }
}
