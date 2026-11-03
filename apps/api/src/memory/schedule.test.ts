import { describe, expect, it } from 'vitest';
import { addDays, daysToRun, dueDay, localClock, MAX_CATCH_UP } from './schedule.js';

describe('the arena day', () => {
  it('ends in the arena zone, with half an hour of grace', () => {
    // 19:05 UTC on 3 Nov = 00:35 on 4 Nov in Kolkata (UTC+5:30): 3 Nov is due there, not in UTC.
    const now = new Date('2026-11-03T19:05:00Z');
    expect(localClock(now, 'Asia/Kolkata')).toEqual({ day: '2026-11-04', minute: 35 });
    expect(dueDay(now, 'Asia/Kolkata')).toBe('2026-11-03');
    expect(dueDay(now, 'UTC')).toBe('2026-11-02');
    // 00:10 local: still the day before's grace.
    expect(dueDay(new Date('2026-11-03T18:40:00Z'), 'Asia/Kolkata')).toBe('2026-11-02');
  });

  it('follows daylight saving changes (New York, 1 Nov 2026: clocks go back)', () => {
    // 2 Nov 00:30 EST is 05:30 UTC; on 1 Nov 00:30 EDT it was 04:30 UTC.
    expect(dueDay(new Date('2026-11-02T05:29:00Z'), 'America/New_York')).toBe('2026-10-31');
    expect(dueDay(new Date('2026-11-02T05:30:00Z'), 'America/New_York')).toBe('2026-11-01');
    expect(dueDay(new Date('2026-11-01T04:30:00Z'), 'America/New_York')).toBe('2026-10-31');
    // Spring forward (8 Mar 2026): 9 Mar 00:30 EDT is 04:30 UTC.
    expect(dueDay(new Date('2026-03-09T04:30:00Z'), 'America/New_York')).toBe('2026-03-08');
  });

  it('falls back to UTC for an unknown zone', () => {
    expect(dueDay(new Date('2026-11-03T00:45:00Z'), 'Mars/Olympus')).toBe('2026-11-02');
  });

  it('catches up missed days, at most a week, oldest first, never before the arena', () => {
    const now = new Date('2026-11-20T12:00:00Z');
    expect(daysToRun(now, 'UTC', '2026-11-17')).toEqual(['2026-11-18', '2026-11-19']);
    expect(daysToRun(now, 'UTC', '2026-11-19')).toEqual([]);
    const long = daysToRun(now, 'UTC', '2026-10-01');
    expect(long).toHaveLength(MAX_CATCH_UP);
    expect(long[0]).toBe('2026-11-13');
    expect(long.at(-1)).toBe('2026-11-19');
    expect(daysToRun(now, 'UTC', null)).toHaveLength(MAX_CATCH_UP);
    expect(daysToRun(now, 'UTC', null, '2026-11-18')).toEqual(['2026-11-18', '2026-11-19']);
    expect(daysToRun(now, 'UTC', null, '2026-11-20')).toEqual([]);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
