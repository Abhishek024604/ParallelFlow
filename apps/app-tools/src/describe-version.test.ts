import { describe, expect, it } from 'vitest';
import { describeVersion } from './db.js';

describe('describeVersion', () => {
  const base = {
    type: 'user' as const,
    name: 'Asha',
    for: null,
    source: 'push',
    private_no: 3,
    approver: 'Ravi',
    approved_at: new Date('2026-10-18T14:05:00Z'),
    at: new Date('2026-10-17T09:30:00Z'),
  };

  it('says who pushed it, when, and who approved it, in plain words', () => {
    expect(describeVersion(base, 2)).toEqual({
      written_by: 'Asha',
      how: 'Pushed from Private v3 by Asha',
      when: '17 Oct 2026, 09:30 UTC',
      approved_by: 'Ravi',
      approved_on: '18 Oct 2026, 14:05 UTC',
    });
  });

  it('names the AI and the person it worked for', () => {
    const out = describeVersion(
      {
        ...base,
        type: 'agent',
        name: null,
        for: 'Ravi',
        source: 'arena_turn',
        approver: null,
        approved_at: null,
      },
      1,
    );
    expect(out.written_by).toBe('AI for Ravi');
    expect(out.how).toBe('Written by AI for Ravi');
    expect(JSON.stringify(out)).not.toMatch(/T\d\d:\d\d/);
  });
});
