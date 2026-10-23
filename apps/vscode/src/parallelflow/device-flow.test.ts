import { describe, expect, it, vi } from 'vitest';
import type { DeviceCode, DeviceTokenResult } from './api.js';
import { DeviceFlowError, runDeviceFlow } from './device-flow.js';

const CODE: DeviceCode = {
  device_code: 'dev-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'http://localhost:3000/ext/device',
  verification_uri_complete: 'http://localhost:3000/ext/device?code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
};
const TOKEN = {
  access_token: 'tok',
  token_type: 'Bearer',
  expires_in: 3600,
  user: { id: 'u1', display_name: 'Priya', email: 'p@x.dev' },
};

function harness(results: (DeviceTokenResult | Error)[], code: DeviceCode = CODE) {
  let now = 0;
  const sleeps: number[] = [];
  const present = vi.fn();
  const deviceToken = vi.fn(async () => {
    const r = results.shift();
    if (!r) throw new Error('no more results');
    if (r instanceof Error) throw r;
    return r;
  });
  const deps = {
    deviceCode: vi.fn(async () => code),
    deviceToken,
    present,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    now: () => now,
  };
  return { deps, sleeps, present, deviceToken };
}

describe('runDeviceFlow', () => {
  it('presents the code, polls at the interval and returns the token', async () => {
    const h = harness([
      { ok: false, error: 'authorization_pending' },
      { ok: false, error: 'authorization_pending' },
      { ok: true, token: TOKEN },
    ]);
    await expect(runDeviceFlow(h.deps)).resolves.toEqual(TOKEN);
    expect(h.present).toHaveBeenCalledWith(CODE);
    expect(h.sleeps).toEqual([5000, 5000, 5000]);
  });

  it('slows down by 5 s on slow_down', async () => {
    const h = harness([
      { ok: false, error: 'slow_down' },
      { ok: false, error: 'authorization_pending' },
      { ok: true, token: TOKEN },
    ]);
    await runDeviceFlow(h.deps);
    expect(h.sleeps).toEqual([5000, 10000, 10000]);
  });

  it('fails on access_denied and expired_token', async () => {
    await expect(
      runDeviceFlow(harness([{ ok: false, error: 'access_denied' }]).deps),
    ).rejects.toMatchObject({ reason: 'denied' });
    await expect(
      runDeviceFlow(harness([{ ok: false, error: 'expired_token' }]).deps),
    ).rejects.toMatchObject({ reason: 'expired' });
  });

  it('expires locally when the code lifetime passes', async () => {
    const pending = Array.from({ length: 10 }, () => ({
      ok: false as const,
      error: 'authorization_pending' as const,
    }));
    const h = harness(pending, { ...CODE, expires_in: 12 });
    await expect(runDeviceFlow(h.deps)).rejects.toBeInstanceOf(DeviceFlowError);
    expect(h.deviceToken).toHaveBeenCalledTimes(2);
  });

  it('retries network errors with backoff, then gives up', async () => {
    const h = harness([new Error('ECONNREFUSED'), { ok: true, token: TOKEN }]);
    await expect(runDeviceFlow(h.deps)).resolves.toEqual(TOKEN);
    expect(h.sleeps).toEqual([5000, 10000]);
    const failing = harness(Array.from({ length: 5 }, () => new Error('down')));
    await expect(runDeviceFlow(failing.deps)).rejects.toMatchObject({ reason: 'unreachable' });
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    const h = harness([{ ok: false, error: 'authorization_pending' }]);
    abort.abort();
    await expect(runDeviceFlow({ ...h.deps, signal: abort.signal })).rejects.toMatchObject({
      reason: 'cancelled',
    });
  });
});
