import type { ArenaMessage } from '@saras/contracts';
import { describe, expect, it } from 'vitest';
import { dayLabel, mergeMessages, relativeAge, threadSummary } from './chat';

const msg = (id: string, created_at: string): ArenaMessage => ({
  id,
  arena_id: 'a',
  parent_id: null,
  author: { type: 'user', id: 'u', display_name: 'Riya Sharma', initials: 'RS', roles: [] },
  body: 'hi',
  kind: 'text',
  attachments: [],
  artifact_refs: [],
  edited_at: null,
  created_at,
});

describe('mergeMessages', () => {
  const a = msg('01', '2026-10-16T10:00:00.000001Z');
  const b = msg('02', '2026-10-16T10:00:00.000002Z');
  const c = msg('03', '2026-10-16T10:00:00.000003Z');

  it('appends new messages and drops ones it already has (own post, then the poll)', () => {
    const afterPost = mergeMessages([a], [b]);
    expect(mergeMessages(afterPost, [b, c]).map((m) => m.id)).toEqual(['01', '02', '03']);
  });

  it('returns the same array when nothing is new', () => {
    const current = [a, b];
    expect(mergeMessages(current, [b])).toBe(current);
  });

  it('keeps stream order when a message arrives out of order', () => {
    expect(mergeMessages([a, c], [b]).map((m) => m.id)).toEqual(['01', '02', '03']);
  });
});

describe('dayLabel', () => {
  const now = new Date(2026, 9, 16, 12, 0);
  it('says Today and Yesterday', () => {
    expect(dayLabel(new Date(2026, 9, 16, 1, 0).toISOString(), now)).toBe('Today');
    expect(dayLabel(new Date(2026, 9, 15, 23, 0).toISOString(), now)).toBe('Yesterday');
  });
});

describe('relativeAge', () => {
  const now = new Date('2026-10-16T12:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it.each([
    [10_000, 'now'],
    [5 * 60_000, '5m'],
    [3 * 3_600_000, '3h'],
    [4 * 86_400_000, '4d'],
    [14 * 86_400_000, '2w'],
  ])('%i ms ago → %s', (ms, label) => {
    expect(relativeAge(ago(ms), now)).toBe(label);
  });
});

describe('threadSummary', () => {
  it('adds replies newer than the server summary, and only those', () => {
    const root = {
      ...msg('01', '2026-10-16T10:00:00.000001Z'),
      thread: {
        reply_count: 2,
        last_reply_at: '2026-10-16T10:00:00.000003Z',
        last_reply_by: 'Asha',
      },
    };
    const old = { ...msg('03', '2026-10-16T10:00:00.000003Z'), parent_id: '01' };
    const fresh = { ...msg('04', '2026-10-16T10:00:00.000004Z'), parent_id: '01' };
    expect(threadSummary(root, [old])).toEqual(root.thread);
    expect(threadSummary(root, [old, fresh])).toMatchObject({
      reply_count: 3,
      last_reply_by: 'Riya Sharma',
    });
    expect(threadSummary(msg('05', '2026-10-16T10:00:00.000005Z'), [])).toBeUndefined();
  });
});
