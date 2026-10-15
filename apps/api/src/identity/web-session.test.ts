import { describe, expect, it } from 'vitest';
import type { SessionRefresh } from './identity-provider.js';
import { RefreshCoalescer, RevokedSessions } from './web-session.js';

describe('RevokedSessions', () => {
  it('remembers a session until the TTL and forgets it after', () => {
    const revoked = new RevokedSessions(1000);
    revoked.add('s1', 0);
    expect(revoked.has('s1', 999)).toBe(true);
    expect(revoked.has('s1', 1000)).toBe(false);
    expect(revoked.has('s2', 0)).toBe(false);
  });

  it('is bounded: the oldest entry goes first', () => {
    const revoked = new RevokedSessions(10_000, 2);
    revoked.add('a', 0);
    revoked.add('b', 1);
    revoked.add('c', 2);
    expect([revoked.has('a', 3), revoked.has('b', 3), revoked.has('c', 3)]).toEqual([
      false,
      true,
      true,
    ]);
  });
});

describe('RefreshCoalescer', () => {
  const ok: SessionRefresh = {
    status: 'refreshed',
    sealedSession: 'new',
    sessionId: 'sid',
    user: { id: 'u', email: 'a@b.io', emailVerified: true, firstName: null, lastName: null },
  };

  it('runs one refresh for concurrent callers with the same session and reuses it briefly', async () => {
    const coalescer = new RefreshCoalescer(1000);
    let calls = 0;
    const refresh = async () => {
      calls += 1;
      return ok;
    };
    const [a, b] = await Promise.all([
      coalescer.run('old', 0, refresh),
      coalescer.run('old', 0, refresh),
    ]);
    expect([a, b, calls]).toEqual([ok, ok, 1]);
    expect(await coalescer.run('old', 500, refresh)).toBe(ok);
    expect(calls).toBe(1);
    await coalescer.run('old', 1000, refresh);
    expect(calls).toBe(2);
    await coalescer.run('other', 1000, refresh);
    expect(calls).toBe(3);
  });

  it('does not reuse failures', async () => {
    const coalescer = new RefreshCoalescer(1000);
    let calls = 0;
    const ended = async (): Promise<SessionRefresh> => {
      calls += 1;
      return { status: 'unavailable' };
    };
    await coalescer.run('s', 0, ended);
    await coalescer.run('s', 1, ended);
    expect(calls).toBe(2);
  });
});
