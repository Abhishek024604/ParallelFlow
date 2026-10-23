import type { CookieOptions, Request, Response } from 'express';

// Cookie names and attributes for the web session (doc 07 §7.1, doc 10 §10.3, §10.5).
//
//   parallelflow_session  HttpOnly, SameSite=Lax, Path=/, Secure*   signed envelope around the WorkOS session
//   parallelflow_csrf     readable,  SameSite=Lax, Path=/, Secure*   CSRF token the web app echoes in X-CSRF-Token
//   parallelflow_login    HttpOnly, SameSite=Lax, Path=/v1/auth, Secure*, 10 min   login state + PKCE verifier
//
// * Secure unless the redirect URI is http://localhost (config.ts decides).
// The web app proxies /v1/* to the API, so these cookies are set for the web origin.

export const SESSION_COOKIE = 'parallelflow_session';
export const CSRF_COOKIE = 'parallelflow_csrf';
export const LOGIN_STATE_COOKIE = 'parallelflow_login';
export const CSRF_HEADER = 'X-CSRF-Token';

export const LOGIN_STATE_PATH = '/v1/auth';
export const LOGIN_STATE_TTL_MS = 10 * 60 * 1000;

export interface CookiePolicy {
  secure: boolean;
  /**
   * Domain for `parallelflow_csrf` only, so a web app on a sibling host (app.example.com → api.example.com)
   * can read it. Unset = host-only. `parallelflow_session` is always host-only.
   */
  csrfDomain?: string;
}

/** One cookie value from the Cookie header, or undefined. The first occurrence wins. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      return decodeURIComponent(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function base(policy: CookiePolicy, httpOnly: boolean): CookieOptions {
  return { httpOnly, secure: policy.secure, sameSite: 'lax', path: '/' };
}

function csrfOptions(policy: CookiePolicy): CookieOptions {
  return {
    ...base(policy, false),
    ...(policy.csrfDomain && { domain: policy.csrfDomain }),
  };
}

export function setSessionCookies(
  res: Response,
  policy: CookiePolicy,
  session: { value: string; csrf: string; maxAgeMs: number },
): void {
  const maxAge = Math.max(0, Math.floor(session.maxAgeMs));
  res.cookie(SESSION_COOKIE, session.value, { ...base(policy, true), maxAge });
  res.cookie(CSRF_COOKIE, session.csrf, { ...csrfOptions(policy), maxAge });
}

export function clearSessionCookies(res: Response, policy: CookiePolicy): void {
  res.clearCookie(SESSION_COOKIE, base(policy, true));
  res.clearCookie(CSRF_COOKIE, csrfOptions(policy));
}

function loginStateOptions(policy: CookiePolicy): CookieOptions {
  return { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: LOGIN_STATE_PATH };
}

export function setLoginStateCookie(res: Response, policy: CookiePolicy, value: string): void {
  res.cookie(LOGIN_STATE_COOKIE, value, {
    ...loginStateOptions(policy),
    maxAge: LOGIN_STATE_TTL_MS,
  });
}

export function clearLoginStateCookie(res: Response, policy: CookiePolicy): void {
  res.clearCookie(LOGIN_STATE_COOKIE, loginStateOptions(policy));
}
