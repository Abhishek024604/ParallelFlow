import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityJobs } from './activity-jobs.js';

// The debounce only (the render itself needs a database: activity-log.test.ts covers the text).

const scope = { orgId: 'o', projectId: 'p' };

function jobs(now: () => number) {
  const runs: string[] = [];
  const j = new ActivityJobs({
    db: {} as never,
    repos: {} as never,
    logger: { warn: vi.fn(), info: vi.fn() } as never,
    clock: now,
    debounceMs: 1000,
    maxWaitMs: 2500,
  });
  // Count renders without a database.
  (j as unknown as { run: (s: typeof scope) => Promise<void> }).run = async (s) => {
    runs.push(s.projectId);
  };
  return { j, runs };
}

afterEach(() => vi.useRealTimers());

describe('activity log jobs', () => {
  it('renders once after the quiet period, and at the latest after the max wait', async () => {
    vi.useFakeTimers();
    const { j, runs } = jobs(() => Date.now());
    j.touch(scope);
    await vi.advanceTimersByTimeAsync(900);
    j.touch(scope);
    await vi.advanceTimersByTimeAsync(900);
    expect(runs).toEqual([]);
    // 1.8 s after the first touch: this one waits only until the max wait (2.5 s).
    j.touch(scope);
    await vi.advanceTimersByTimeAsync(600);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    await j.idle('p');
    expect(runs).toEqual(['p']);
  });

  it('flush renders at once and cancels the waiting one', async () => {
    vi.useFakeTimers();
    const { j, runs } = jobs(() => Date.now());
    j.touch(scope);
    j.flush(scope);
    await j.idle('p');
    await vi.advanceTimersByTimeAsync(5000);
    expect(runs).toEqual(['p']);
    j.stop();
  });
});
