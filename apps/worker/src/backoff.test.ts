import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY, IdleBackoff, retryDelayRange, retryPolicy } from './backoff.js';

describe('IdleBackoff', () => {
  it('polls at once after a full batch and every min while rows keep coming', () => {
    const b = new IdleBackoff(250, 2000);
    expect(b.afterPoll(100, 100)).toBe(0);
    expect(b.afterPoll(3, 100)).toBe(250);
  });

  it('doubles while idle up to max, and resets on work', () => {
    const b = new IdleBackoff(250, 2000);
    expect([0, 0, 0, 0, 0, 0].map(() => b.afterPoll(0, 100))).toEqual([
      250, 500, 1000, 2000, 2000, 2000,
    ]);
    expect(b.afterPoll(1, 100)).toBe(250);
    expect(b.afterPoll(0, 100)).toBe(250);
  });

  it('waits the longest after an error', () => {
    const b = new IdleBackoff(250, 2000);
    expect(b.afterError()).toBe(2000);
    expect(b.afterPoll(0, 100)).toBe(2000);
  });

  it('rejects nonsense bounds', () => {
    expect(() => new IdleBackoff(0, 10)).toThrow();
    expect(() => new IdleBackoff(100, 10)).toThrow();
  });
});

describe('retry policy', () => {
  it('defaults to exponential backoff with a dead-letter limit', () => {
    expect(retryPolicy()).toEqual(DEFAULT_RETRY);
    expect(DEFAULT_RETRY.retryBackoff).toBe(true);
    expect(DEFAULT_RETRY.retryLimit).toBeGreaterThan(0);
  });

  it('accepts overrides and validates them', () => {
    expect(retryPolicy({ retryLimit: 2, retryDelay: 1 })).toMatchObject({
      retryLimit: 2,
      retryDelay: 1,
    });
    expect(() => retryPolicy({ retryLimit: -1 })).toThrow();
    expect(() => retryPolicy({ retryLimit: 1.5 })).toThrow();
    expect(() => retryPolicy({ retryDelay: 0 })).toThrow();
    expect(() => retryPolicy({ retryDelay: 10, retryDelayMax: 5 })).toThrow();
  });

  it('describes the wait pg-boss picks: doubling, jittered down to half, capped', () => {
    const p = retryPolicy({ retryDelay: 5, retryDelayMax: 60 });
    expect(retryDelayRange(p, 0)).toEqual([2.5, 5]);
    expect(retryDelayRange(p, 1)).toEqual([5, 10]);
    expect(retryDelayRange(p, 3)).toEqual([20, 40]);
    expect(retryDelayRange(p, 5)).toEqual([60, 60]);
    expect(retryDelayRange({ ...p, retryBackoff: false }, 5)).toEqual([5, 5]);
  });
});
