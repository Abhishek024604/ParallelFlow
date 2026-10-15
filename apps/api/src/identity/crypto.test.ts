import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decrypt,
  deriveKeys,
  encrypt,
  pkceChallenge,
  pkcePair,
  randomToken,
  safeEqual,
} from './crypto.js';

const PASSWORD = 'p'.repeat(40);

describe('deriveKeys', () => {
  it('derives distinct 32-byte keys per purpose, stable per password', () => {
    const a = deriveKeys(PASSWORD);
    expect(a.sessionMac).toHaveLength(32);
    expect(a.loginState).toHaveLength(32);
    expect(a.sessionMac.equals(a.loginState)).toBe(false);
    expect(deriveKeys(PASSWORD).sessionMac.equals(a.sessionMac)).toBe(true);
    expect(deriveKeys('q'.repeat(40)).sessionMac.equals(a.sessionMac)).toBe(false);
  });
});

describe('safeEqual', () => {
  it('compares exactly, including length', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('encrypt / decrypt', () => {
  const { loginState: key } = deriveKeys(PASSWORD);

  it('round-trips JSON and never shows the plaintext', () => {
    const sealed = encrypt(key, { state: 'S3CRET-STATE', n: 1 });
    expect(sealed).not.toContain('S3CRET');
    expect(sealed).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decrypt(key, sealed)).toEqual({ state: 'S3CRET-STATE', n: 1 });
  });

  it('rejects tampering, another key and garbage', () => {
    const sealed = encrypt(key, { a: 1 });
    const flipped = sealed.slice(0, -2) + (sealed.at(-2) === 'A' ? 'B' : 'A') + sealed.at(-1);
    expect(decrypt(key, flipped)).toBeUndefined();
    expect(decrypt(deriveKeys('x'.repeat(40)).loginState, sealed)).toBeUndefined();
    expect(decrypt(key, 'not-base64!')).toBeUndefined();
    expect(decrypt(key, '')).toBeUndefined();
  });
});

describe('pkce', () => {
  it('builds an S256 challenge from a 43-character verifier (RFC 7636)', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    // RFC 7636 appendix B
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('random tokens are long and unique', () => {
    expect(randomToken()).toHaveLength(43);
    expect(new Set(Array.from({ length: 100 }, () => randomToken())).size).toBe(100);
  });
});
