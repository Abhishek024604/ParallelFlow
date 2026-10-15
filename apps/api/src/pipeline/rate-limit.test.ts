import { describe, expect, it } from 'vitest';
import { evaluate, rateLimitHeaders, tightest, windowStart } from './rate-limit.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 16, 9, 30, 0); // a minute boundary

describe('windowStart', () => {
  it('floors to the start of the fixed window', () => {
    expect(windowStart(T0, MIN)).toBe(T0);
    expect(windowStart(T0 + 59_999, MIN)).toBe(T0);
    expect(windowStart(T0 + MIN, MIN)).toBe(T0 + MIN);
  });
});

describe('evaluate', () => {
  it('counts down remaining and allows exactly `limit` requests', () => {
    expect(evaluate(1, 3, T0, MIN)).toMatchObject({ limit: 3, remaining: 2, exceeded: false });
    expect(evaluate(3, 3, T0, MIN)).toMatchObject({ remaining: 0, exceeded: false });
    expect(evaluate(4, 3, T0, MIN)).toMatchObject({ remaining: 0, exceeded: true });
  });

  it('reports whole seconds until the window ends, never 0', () => {
    expect(evaluate(1, 3, T0, MIN).resetSeconds).toBe(60);
    expect(evaluate(1, 3, T0 + 15_500, MIN).resetSeconds).toBe(45);
    expect(evaluate(1, 3, T0 + 59_999, MIN).resetSeconds).toBe(1);
  });
});

describe('tightest', () => {
  const user = evaluate(10, 600, T0, MIN);
  const org = evaluate(5990, 6000, T0, MIN);

  it('reports the limit with the fewest requests left', () => {
    expect(tightest([user, org])).toBe(org);
  });

  it('prefers an exceeded limit', () => {
    const over = evaluate(601, 600, T0, MIN);
    expect(tightest([org, over])).toBe(over);
  });

  it('is undefined for no limits', () => {
    expect(tightest([])).toBeUndefined();
  });
});

describe('rateLimitHeaders', () => {
  it('uses the RateLimit-* names from doc 07 §7.1', () => {
    expect(rateLimitHeaders(evaluate(1, 600, T0 + 30_000, MIN))).toEqual({
      'RateLimit-Limit': '600',
      'RateLimit-Remaining': '599',
      'RateLimit-Reset': '30',
    });
  });
});
