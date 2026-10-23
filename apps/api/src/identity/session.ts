import { z } from 'zod';
import { hmac, safeEqual } from './crypto.js';

// The `parallelflow_session` cookie value (doc 10 §10.3):
//
//   s1.<meta>.<mac>.<sealed>
//
//   meta    base64url JSON { uid, iat, seen, csrf }: our user id, issued-at and last-seen (ms), and
//           the CSRF token bound to this session
//   mac     HMAC-SHA256 over "s1.<meta>.<sealed>" with a key derived from WORKOS_COOKIE_PASSWORD
//   sealed  the WorkOS sealed session (encrypted by the SDK with the same password)
//
// The MAC binds the timestamps and the CSRF token to this exact WorkOS session, so they cannot be
// swapped between cookies. The server enforces 12 h absolute and 2 h idle from `iat` / `seen`
// without a session table; `seen` is re-issued at most every SEEN_RESOLUTION_MS.

export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000;
/** Re-issue the cookie with a new `seen` at most this often (bounds Set-Cookie churn). */
export const SEEN_RESOLUTION_MS = 5 * 60 * 1000;
/** Tolerated clock skew between API instances for `iat` / `seen` in the future. */
const MAX_SKEW_MS = 60 * 1000;
const PREFIX = 's1';

export interface SessionLimits {
  absoluteMs: number;
  idleMs: number;
}

export const DEFAULT_SESSION_LIMITS: SessionLimits = {
  absoluteMs: SESSION_ABSOLUTE_MS,
  idleMs: SESSION_IDLE_MS,
};

const MetaSchema = z
  .object({
    uid: z.string().uuid(),
    iat: z.number().int().nonnegative(),
    seen: z.number().int().nonnegative(),
    csrf: z.string().min(16).max(128),
  })
  .strict();

export type SessionMeta = z.infer<typeof MetaSchema>;

export interface DecodedSession {
  meta: SessionMeta;
  /** The WorkOS sealed session. */
  sealed: string;
}

export function encodeSession(key: Buffer, meta: SessionMeta, sealed: string): string {
  const encodedMeta = Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url');
  const mac = hmac(key, `${PREFIX}.${encodedMeta}.${sealed}`);
  return `${PREFIX}.${encodedMeta}.${mac}.${sealed}`;
}

/** Undefined for anything that is not an untampered envelope issued with this key. */
export function decodeSession(key: Buffer, value: string): DecodedSession | undefined {
  if (value.length > 8192) return undefined;
  const first = value.indexOf('.');
  const second = value.indexOf('.', first + 1);
  const third = value.indexOf('.', second + 1);
  if (first < 0 || second < 0 || third < 0) return undefined;
  const prefix = value.slice(0, first);
  const encodedMeta = value.slice(first + 1, second);
  const mac = value.slice(second + 1, third);
  const sealed = value.slice(third + 1);
  if (prefix !== PREFIX || !encodedMeta || !mac || !sealed) return undefined;
  if (!safeEqual(mac, hmac(key, `${PREFIX}.${encodedMeta}.${sealed}`))) return undefined;
  try {
    const json = JSON.parse(Buffer.from(encodedMeta, 'base64url').toString('utf8')) as unknown;
    const meta = MetaSchema.safeParse(json);
    return meta.success ? { meta: meta.data, sealed } : undefined;
  } catch {
    return undefined;
  }
}

export type SessionAge =
  | { ok: false; reason: 'absolute' | 'idle' | 'future' }
  | { ok: true; /** Re-issue the cookie with seen = now. */ touch: boolean; remainingMs: number };

/** Applies the absolute and idle limits (doc 10 §10.3). Pure, so it is unit tested. */
export function checkAge(meta: SessionMeta, now: number, limits: SessionLimits): SessionAge {
  if (meta.iat > now + MAX_SKEW_MS || meta.seen > now + MAX_SKEW_MS || meta.seen < meta.iat) {
    return { ok: false, reason: 'future' };
  }
  const remainingMs = meta.iat + limits.absoluteMs - now;
  if (remainingMs <= 0) return { ok: false, reason: 'absolute' };
  if (now - meta.seen >= limits.idleMs) return { ok: false, reason: 'idle' };
  return { ok: true, touch: now - meta.seen >= SEEN_RESOLUTION_MS, remainingMs };
}
