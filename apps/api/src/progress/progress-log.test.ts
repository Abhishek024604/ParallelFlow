import { describe, expect, it } from 'vitest';
import {
  commitsForEntry,
  lastEntryAt,
  mergeLog,
  parseLog,
  type ProgressContext,
  type ProgressEntry,
  type ProgressFacts,
  publicCopy,
} from './progress-log.js';

const facts: ProgressFacts = {
  since: '2026-10-17T09:00:00.000Z',
  until: '2026-10-18T10:00:01.000Z',
  cycle: 1,
  stage: 'DESIGN',
  moves: [
    {
      at: '2026-10-18T10:00:00.000Z',
      cycle: 1,
      from: 'PLAN',
      to: 'DESIGN',
      kind: 'advance',
      actor: 'Asha',
      reason: null,
    },
  ],
  approvals: [
    {
      at: '2026-10-18T10:00:00.000Z',
      stage: 'PLAN',
      status: 'approved',
      summary: 'Scope agreed',
      document: 'plan.md',
      deciders: ['Asha'],
      reasons: [],
    },
  ],
  versions: [
    { at: '2026-10-18T09:40:00.000Z', name: 'plan.md', version: 2, author: 'Riya', pushedFrom: 3 },
    {
      at: '2026-10-18T09:50:00.000Z',
      name: 'spec.md',
      version: 1,
      author: 'AI for Riya',
      pushedFrom: null,
    },
  ],
  approvedVersions: [{ at: '2026-10-18T10:00:00.000Z', name: 'plan.md', version: 2, by: 'Asha' }],
  humanMessages: 12,
  aiMessages: 3,
};

const ctx: ProgressContext = {
  current: { number: 1, stage: 'DESIGN', status: 'active' },
  moves: [
    { ...facts.moves[0]!, at: '2026-10-17T08:00:00.000Z', from: null, to: 'PLAN', kind: 'open' },
    ...facts.moves,
  ],
  decisions: [
    {
      at: '2026-10-17T12:00:00.000Z',
      stage: 'PLAN',
      status: 'rejected',
      summary: null,
      document: null,
      deciders: ['Asha'],
      reasons: ['Needs a budget'],
    },
    ...facts.approvals,
  ],
};

const entry = (
  id: string,
  at: string,
  trigger: ProgressEntry['trigger'] = 'gate',
): ProgressEntry => ({
  id,
  at,
  trigger,
  facts,
  commits: [],
});

const commit = (sha: string, message: string, at: string) => ({ sha, message, author: 'Asha', at });

describe('progress.md', () => {
  it('renders an entry section with every kind of fact, and a dated timeline', () => {
    const file = mergeLog(null, ctx, {
      ...entry('gate:a1', '2026-10-18T10:00:01.000Z'),
      commits: [
        commit('abcdef1234', 'Approve PLAN gate · cycle 1 → DESIGN', '2026-10-18T10:00:02Z'),
      ],
    });
    expect(file).toContain('**Now:** Cycle 1 · DESIGN (active)');
    expect(file).toContain('](state.md)');
    // Timeline: newest date first; a rejection shows, an approval shows as its stage move.
    const timeline = file.slice(file.indexOf('## Timeline'), file.indexOf('## Log'));
    expect(timeline.indexOf('### 2026-10-18')).toBeLessThan(timeline.indexOf('### 2026-10-17'));
    expect(timeline).toContain('- 10:00 UTC · Cycle 1 · PLAN → DESIGN · approved by Asha');
    expect(timeline).toContain('PLAN gate not approved by Asha: Needs a budget');
    // Each commit with its time, the stage it landed in, and its author.
    expect(timeline).toContain(
      '- 10:00 UTC · DESIGN · `abcdef1` Approve PLAN gate · cycle 1 → DESIGN · by Asha',
    );
    // The entry.
    expect(file).toContain('### 2026-10-18 10:00 UTC · Cycle 1 · DESIGN · PLAN gate approved');
    expect(file).toContain('_After a gate approval · covers since 2026-10-17 09:00 UTC_');
    expect(file).toContain('- The cycle moved PLAN → DESIGN.');
    expect(file).not.toContain('messages from the team');
    expect(file).toContain(
      '- 2026-10-18 10:00 UTC · PLAN gate approved by Asha, with plan.md: Scope agreed',
    );
    expect(file).toContain('**Files pushed**\n\n- plan.md · Private v3 → arena v2 · by Riya');
    expect(file).toContain('**New versions**\n\n- spec.md v1 · by AI for Riya');
    expect(file).toContain('**Approved versions**\n\n- plan.md v2 · approved by Asha');
    expect(file).toContain(
      '**Commits**\n\n- `abcdef1` Approve PLAN gate · cycle 1 → DESIGN · Asha · DESIGN · 2026-10-18 10:00 UTC',
    );
    expect(publicCopy(file)).not.toContain('progress-entry');
  });

  it('keeps entries newest first and replaces an entry with the same id', () => {
    let log = mergeLog(null, ctx, entry('m1', '2026-10-18T09:00:00.000Z', 'messages'));
    log = mergeLog(log, ctx, entry('gate:a1', '2026-10-18T10:00:00.000Z'));
    log = mergeLog(log, ctx, {
      ...entry('gate:a1', '2026-10-18T10:00:00.000Z'),
      commits: [commit('1234567aaa', 'Approve PLAN gate', '2026-10-18T10:00:02Z')],
    });
    expect(parseLog(log).map((e) => e.id)).toEqual(['gate:a1', 'm1']);
    expect(log.match(/PLAN gate approved by Asha, with/g)).toHaveLength(2);
    expect(log).toContain('`1234567`');
    expect(lastEntryAt(log, 'gate:a1')).toBe('2026-10-18T09:00:00.000Z');
  });

  it('lists each repo commit once and skips log refreshes', () => {
    const log = mergeLog(null, ctx, {
      ...entry('gate:a1', '2026-10-18T10:00:00.000Z'),
      commits: [commit('1111111aaa', 'Approve PLAN gate', '2026-10-18T10:00:02Z')],
    });
    const all = [
      commit('2222222bbb', 'Approve DESIGN gate', '2026-10-19T10:00:02Z'),
      commit('3333333ccc', 'Update progress and state', '2026-10-18T10:01:00Z'),
      commit('1111111aaa', 'Approve PLAN gate', '2026-10-18T10:00:02Z'),
    ];
    expect(commitsForEntry(log, 'gate:a2', all).map((c) => c.sha)).toEqual(['2222222bbb']);
    // Re-rendering the entry that already lists a commit keeps it.
    expect(commitsForEntry(log, 'gate:a1', all).map((c) => c.sha)).toEqual([
      '1111111aaa',
      '2222222bbb',
    ]);
  });

  it('starts fresh over the old AI-written log', () => {
    const legacy = '# Progress log\n\n<!-- progress-entry id=m0 at=2026-10-01T00:00:00Z -->\n## x';
    expect(parseLog(legacy)).toEqual([]);
    const file = mergeLog(legacy, ctx, entry('m1', '2026-10-18T09:00:00.000Z', 'messages'));
    expect(parseLog(file).map((e) => e.id)).toEqual(['m1']);
  });
});
