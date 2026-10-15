import { describe, expect, it } from 'vitest';
import { deriveKeys } from './crypto.js';
import {
  checkAge,
  decodeSession,
  DEFAULT_SESSION_LIMITS,
  encodeSession,
  SEEN_RESOLUTION_MS,
  type SessionMeta,
} from './session.js';

const H = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 16, 9, 0, 0);
const { sessionMac: key } = deriveKeys('k'.repeat(40));
const meta: SessionMeta = {
  uid: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  iat: T0,
  seen: T0,
  csrf: 'c'.repeat(43),
};
const SEALED = 'Fe26.2*1*abc*def*ghi**jkl*mno~2';

describe('encodeSession / decodeSession', () => {
  it('round-trips meta and the sealed session', () => {
    const value = encodeSession(key, meta, SEALED);
    expect(value.startsWith('s1.')).toBe(true);
    expect(value.endsWith(SEALED)).toBe(true);
    expect(decodeSession(key, value)).toEqual({ meta, sealed: SEALED });
  });

  it('rejects any change to meta, MAC or sealed part, and another key', () => {
    const value = encodeSession(key, meta, SEALED);
    const [prefix, encodedMeta, mac] = value.split('.', 3) as [string, string, string];
    const forgedMeta = Buffer.from(JSON.stringify({ ...meta, iat: T0 + 10 * H })).toString(
      'base64url',
    );
    for (const bad of [
      `${prefix}.${forgedMeta}.${mac}.${SEALED}`,
      `${prefix}.${encodedMeta}.${mac}.${SEALED}x`,
      `${prefix}.${encodedMeta}.${mac.slice(0, -1)}A.${SEALED}`,
      `s2.${encodedMeta}.${mac}.${SEALED}`,
      'garbage',
      '',
      's1...',
    ]) {
      expect(decodeSession(key, bad), bad).toBeUndefined();
    }
    expect(decodeSession(deriveKeys('z'.repeat(40)).sessionMac, value)).toBeUndefined();
  });

  it('rejects a correctly signed envelope with malformed meta', () => {
    const badMeta = encodeSession(key, { ...meta, uid: 'not-a-uuid' }, SEALED);
    expect(decodeSession(key, badMeta)).toBeUndefined();
  });
});

describe('checkAge (12 h absolute, 2 h idle)', () => {
  const at = (now: number, m: Partial<SessionMeta> = {}) =>
    checkAge({ ...meta, ...m }, now, DEFAULT_SESSION_LIMITS);

  it('accepts a fresh session without touching it', () => {
    expect(at(T0)).toEqual({ ok: true, touch: false, remainingMs: 12 * H });
    expect(at(T0 + SEEN_RESOLUTION_MS - 1)).toMatchObject({ ok: true, touch: false });
  });

  it('asks to re-issue `seen` once it is older than the resolution', () => {
    expect(at(T0 + SEEN_RESOLUTION_MS)).toMatchObject({ ok: true, touch: true });
  });

  it('expires after 2 h idle', () => {
    expect(at(T0 + 2 * H - 1)).toMatchObject({ ok: true });
    expect(at(T0 + 2 * H)).toEqual({ ok: false, reason: 'idle' });
  });

  it('expires 12 h after sign-in even when active', () => {
    const active = { seen: T0 + 11 * H + 59 * 60_000 };
    expect(at(T0 + 12 * H - 1, active)).toMatchObject({ ok: true, remainingMs: 1 });
    expect(at(T0 + 12 * H, { seen: T0 + 12 * H - 1000 })).toEqual({
      ok: false,
      reason: 'absolute',
    });
  });

  it('rejects timestamps from the future or seen before issue', () => {
    expect(at(T0 - 5 * 60_000)).toEqual({ ok: false, reason: 'future' });
    expect(at(T0, { seen: T0 - 1 })).toEqual({ ok: false, reason: 'future' });
    expect(at(T0 - 30_000)).toMatchObject({ ok: true }); // small skew is tolerated
  });
});
