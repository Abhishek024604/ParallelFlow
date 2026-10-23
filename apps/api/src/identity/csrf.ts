import { safeEqual } from './crypto.js';

// CSRF (doc 10 §10.5): SameSite=Lax cookies plus a double-submit token. The token is random per
// session, stored inside the signed `parallelflow_session` envelope and in the readable `parallelflow_csrf` cookie.
// The web app copies the cookie into the X-CSRF-Token header on every state-changing request. The
// header is compared with the session's token (not with the cookie), so a cookie planted by a sibling
// subdomain cannot satisfy the check.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function csrfRequired(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export function csrfValid(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string' || header.length === 0 || header.length > 256) return false;
  return safeEqual(header, expected);
}
