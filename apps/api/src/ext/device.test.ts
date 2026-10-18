import { describe, expect, it } from 'vitest';
import {
  formatUserCode,
  hasBearer,
  newAccessToken,
  newDeviceCode,
  newUserCode,
  normalizeUserCode,
  parseBearer,
  pollOutcome,
  sha256Hex,
  USER_CODE_ALPHABET,
  type DeviceState,
} from './device.js';

const NOW = new Date('2026-10-18T10:00:00Z');
const later = (s: number) => new Date(NOW.getTime() + s * 1000);
const state = (over: Partial<DeviceState> = {}): DeviceState => ({
  status: 'pending',
  expiresAt: later(600),
  lastPolledAt: null,
  ...over,
});

describe('device code state machine', () => {
  it('is pending until approved, then issues once', () => {
    expect(pollOutcome(state(), NOW)).toEqual({ kind: 'error', error: 'authorization_pending' });
    expect(pollOutcome(state({ status: 'approved' }), NOW)).toEqual({ kind: 'issue' });
    expect(pollOutcome(state({ status: 'used' }), NOW)).toEqual({
      kind: 'error',
      error: 'invalid_grant',
    });
    expect(pollOutcome(null, NOW)).toEqual({ kind: 'error', error: 'invalid_grant' });
  });

  it('tells a fast poller to slow down', () => {
    expect(pollOutcome(state({ lastPolledAt: later(-2) }), NOW).kind).toBe('error');
    expect(pollOutcome(state({ lastPolledAt: later(-2) }), NOW)).toMatchObject({
      error: 'slow_down',
    });
    expect(pollOutcome(state({ lastPolledAt: later(-5) }), NOW)).toMatchObject({
      error: 'authorization_pending',
    });
  });

  it('expires (and marks pending or approved codes expired), and reports a denial', () => {
    expect(pollOutcome(state({ expiresAt: NOW }), NOW)).toEqual({
      kind: 'error',
      error: 'expired_token',
      markExpired: true,
    });
    expect(pollOutcome(state({ status: 'approved', expiresAt: later(-1) }), NOW)).toMatchObject({
      error: 'expired_token',
      markExpired: true,
    });
    expect(pollOutcome(state({ status: 'expired' }), NOW)).toMatchObject({
      error: 'expired_token',
    });
    expect(pollOutcome(state({ status: 'denied' }), NOW)).toEqual({
      kind: 'error',
      error: 'access_denied',
    });
  });
});

describe('user codes', () => {
  it('uses 8 characters of the unambiguous alphabet and reads them back however typed', () => {
    const code = newUserCode();
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{8}$/);
    expect(USER_CODE_ALPHABET).not.toMatch(/[AEIOU01]/);
    expect(formatUserCode('BCDF2345')).toBe('BCDF-2345');
    expect(normalizeUserCode(' bcdf-2345 ')).toBe('BCDF2345');
    expect(normalizeUserCode('BCDF-234')).toBeNull();
    expect(normalizeUserCode('ABCD-2345')).toBeNull();
  });
});

describe('secrets and bearer parsing', () => {
  it('hashes with SHA-256 and makes unguessable secrets', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(newDeviceCode()).not.toBe(newDeviceCode());
    expect(newAccessToken()).toMatch(/^saras_ext_[A-Za-z0-9_-]{43}$/);
  });

  it('accepts only well-formed saras_ext_ bearer tokens', () => {
    const token = newAccessToken();
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer  ${token}`)).toBe(token);
    expect(parseBearer(`Basic ${token}`)).toBeNull();
    expect(parseBearer('Bearer ghp_abcdefabcdefabcdefabcdefabcdefabcdef')).toBeNull();
    expect(parseBearer('Bearer saras_ext_short')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(hasBearer('Bearer x')).toBe(true);
    expect(hasBearer('Basic x')).toBe(false);
  });
});
