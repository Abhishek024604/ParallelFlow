import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

// Small crypto helpers for the web session (doc 10 §10.3, §10.5). Keys are derived from
// WORKOS_COOKIE_PASSWORD with HKDF, one per purpose, so the WorkOS seal key is never reused directly.

export interface AuthKeys {
  /** HMAC-SHA256 key for the `parallelflow_session` envelope. */
  sessionMac: Buffer;
  /** AES-256-GCM key for the short-lived login-state cookie. */
  loginState: Buffer;
}

const SALT = Buffer.from('parallelflow.auth.v1', 'utf8');

export function deriveKeys(cookiePassword: string): AuthKeys {
  const ikm = Buffer.from(cookiePassword, 'utf8');
  const key = (info: string) => Buffer.from(hkdfSync('sha256', ikm, SALT, info, 32));
  return { sessionMac: key('parallelflow_session mac'), loginState: key('parallelflow_login enc') };
}

/** URL- and cookie-safe random token (base64url). 32 bytes = 256 bits by default. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

/**
 * Constant-time string comparison. Both sides are hashed first, so neither the content nor the
 * length of the expected value leaks through timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM: base64url(iv | tag | ciphertext). Authenticated, so tampering is detected. */
export function encrypt(key: Buffer, value: unknown): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** The decrypted JSON value, or undefined if the input is malformed, tampered or for another key. */
export function decrypt(key: Buffer, sealed: string): unknown {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    const text = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** PKCE S256 (RFC 7636): a 43-character verifier and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32);
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
