import { describe, expect, it } from 'vitest';
import { KeyPool, poolFetch, poolKeys, restMs } from './key-pool.js';

const none = { get: () => null };
const T = 1_790_000_000_000;

describe('OpenRouter key pool', () => {
  it('reads OPENROUTER_API_KEYS and OPENROUTER_API_KEY, without blanks or repeats', () => {
    expect(poolKeys({ OPENROUTER_API_KEYS: 'a, b\nc,,a', OPENROUTER_API_KEY: 'd' })).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(poolKeys({})).toEqual([]);
  });

  it('takes turns, and skips a key while it rests', () => {
    let now = 0;
    const pool = new KeyPool(['a', 'b', 'c'], () => now);
    expect([pool.next()?.key, pool.next()?.key, pool.next()?.key]).toEqual(['a', 'b', 'c']);
    pool.rest(0, 1000);
    expect([pool.next()?.key, pool.next()?.key]).toEqual(['b', 'c']);
    pool.rest(1, 1000);
    pool.rest(2, 1000);
    pool.rest(0, 500);
    expect(pool.next()?.key).toBe('a'); // every key rests: the one free soonest
    now = 1000;
    expect(pool.next()?.key).toBe('a');
  });

  it('rests a key until the rate limit resets', () => {
    expect(
      restMs(429, { get: (h) => (h === 'x-ratelimit-reset' ? String(T + 60_000) : null) }, T),
    ).toBe(60_000);
    expect(restMs(429, { get: (h) => (h === 'retry-after' ? '5' : null) }, 0)).toBe(5000);
    expect(restMs(429, none, 0)).toBe(60_000);
    expect(restMs(402, none, 0)).toBe(3_600_000);
  });

  it('sends a refused request again with the next key', async () => {
    const used: string[] = [];
    const fake = (async (_url: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      used.push(auth);
      return new Response('{}', { status: auth === 'Bearer b' ? 200 : 429 });
    }) as typeof fetch;
    const send = poolFetch(new KeyPool(['a', 'b', 'c']), fake);
    const res = await send('https://x/chat', { method: 'POST', body: '{}' });
    expect(res.status).toBe(200);
    expect(used).toEqual(['Bearer a', 'Bearer b']);
  });

  it('returns the last refusal when every key is resting', async () => {
    const fake = (async () => new Response('{}', { status: 429 })) as typeof fetch;
    const send = poolFetch(new KeyPool(['a', 'b']), fake);
    expect((await send('https://x', {})).status).toBe(429);
    expect((await send('https://x', {})).status).toBe(429);
  });
});
