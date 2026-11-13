import type { Database } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TurnRunner } from '../agent/turn-runner.js';
import type { ArenaRepos } from '../repo/git.js';
import type { MemoryNode } from './model.js';
import {
  EVENT_SETTLE_MS,
  EVENT_WINDOW_MS,
  eventRunDelay,
  MemoryJobs,
  memoryTriggerOf,
} from './memory-jobs.js';
import { earlierDelta } from './resolver.js';
import { runWindow } from './schedule.js';

const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as Logger;

describe('event-triggered playbook updates', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers on an approved gate and a pushed or approved file only', () => {
    expect(memoryTriggerOf('loop.gate.approved')).toBe('gate');
    expect(memoryTriggerOf('file.approved')).toBe('file');
    expect(memoryTriggerOf('file.pushed_from_private')).toBe('file');
    expect(memoryTriggerOf('loop.gate.requested')).toBeNull();
    expect(memoryTriggerOf('file.created')).toBeNull();
  });

  it('waits for the settle time, then for the end of the window after the last run', () => {
    expect(eventRunDelay(1_000_000, undefined)).toBe(EVENT_SETTLE_MS);
    expect(eventRunDelay(1_000_000, 1_000_000 - 60_000)).toBe(EVENT_WINDOW_MS - 60_000);
    expect(eventRunDelay(1_000_000, 1_000_000 - EVENT_WINDOW_MS - 1)).toBe(EVENT_SETTLE_MS);
  });

  it('runs at most once per arena per window, and only while the scheduler is on', () => {
    vi.useFakeTimers();
    let now = 5_000_000;
    const jobs = new MemoryJobs({
      db: {} as Database,
      runner: {} as TurnRunner,
      repos: {} as ArenaRepos,
      logger,
      clock: () => now,
    });
    const runs: string[] = [];
    // The run itself needs a database; record the queued runs instead.
    (jobs as unknown as { runToday: (s: { projectId: string }) => Promise<void> }).runToday =
      async (s) => {
        runs.push(s.projectId);
      };
    const scope = { orgId: 'o', projectId: 'p' };
    jobs.trigger(scope, 'gate');
    expect(vi.getTimerCount()).toBe(0); // off: not started

    jobs.start();
    jobs.trigger(scope, 'gate');
    jobs.trigger(scope, 'messages'); // already waiting: no second run
    now += EVENT_SETTLE_MS;
    vi.advanceTimersByTime(EVENT_SETTLE_MS);
    return Promise.resolve()
      .then(() => jobs.idle('p'))
      .then(() => {
        expect(runs).toEqual(['p']);
        jobs.trigger(scope, 'file'); // within the window: waits for its end
        now += EVENT_WINDOW_MS - 1;
        vi.advanceTimersByTime(EVENT_WINDOW_MS - EVENT_SETTLE_MS - 1);
        expect(runs).toEqual(['p']);
        vi.advanceTimersByTime(EVENT_SETTLE_MS + 1);
        return jobs.idle('p');
      })
      .then(() => {
        expect(runs).toEqual(['p', 'p']);
        jobs.stop();
      });
  });

  it('reads only the part of the day after the last run', () => {
    const day = { from: '2026-11-13T00:00:00.000Z', until: '2026-11-14T00:00:00.000Z' };
    expect(runWindow(day, null, null)).toEqual(day);
    expect(runWindow(day, '2026-11-13T09:00:00.000Z', '2026-11-13T12:00:00.000Z')).toEqual({
      from: '2026-11-13T09:00:00.000Z',
      until: '2026-11-13T12:00:00.000Z',
    });
    // A watermark from before the day, or a `until` after it, stays inside the day.
    expect(runWindow(day, '2026-11-12T20:00:00.000Z', '2026-11-15T00:00:00.000Z')).toEqual(day);
    // Never a negative window.
    expect(runWindow(day, '2026-11-13T12:00:00.000Z', '2026-11-13T09:00:00.000Z')).toEqual({
      from: '2026-11-13T12:00:00.000Z',
      until: '2026-11-13T12:00:00.000Z',
    });
  });

  it("tells the night what the day's event runs already changed", () => {
    const node = (over: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'key'>): MemoryNode => ({
      type: 'Decision',
      title: over.key,
      summary: '',
      status: 'active',
      attrs: {},
      firstSeenDay: '2026-11-13',
      lastSeenDay: '2026-11-13',
      ...over,
    });
    const nodes = [
      node({ id: 'a', key: 'D-001', firstSeenDay: '2026-11-10' }),
      node({ id: 'b', key: 'D-002' }),
      node({ id: 'c', key: 'D-003', lastSeenDay: '2026-11-12', firstSeenDay: '2026-11-12' }),
      node({ id: 'd', key: 'D-004' }),
    ];
    const night = [
      {
        change: 'new' as const,
        type: 'Decision' as const,
        key: 'D-004',
        title: 'D-004',
        summary: '',
        status: 'active' as const,
        needsConfirmation: false,
      },
    ];
    expect(earlierDelta(nodes, '2026-11-13', night).map((d) => [d.change, d.key])).toEqual([
      ['new', 'D-002'],
      ['updated', 'D-001'],
    ]);
  });
});
