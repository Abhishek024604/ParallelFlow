import { describe, expect, it } from 'vitest';
import type { ProgressFacts } from './progress-log.js';
import {
  factsDay,
  legacyStateDays,
  mergeState,
  parseAiState,
  parseState,
  renderState,
  type StateDay,
} from './state-log.js';

const day = (date: string, over: Partial<StateDay> = {}): StateDay => ({
  date,
  source: 'ai',
  summary: `Work on ${date}.`,
  decisions: ['Use Postgres'],
  discussed: ['Pricing: free tier stays'],
  questions: ['Who owns billing?'],
  ...over,
});

const facts: ProgressFacts = {
  since: null,
  until: '2026-10-18T10:00:01.000Z',
  cycle: 1,
  stage: 'DESIGN',
  moves: [
    {
      at: '2026-10-18T09:00:00.000Z',
      cycle: 1,
      from: 'DESIGN',
      to: 'PLAN',
      kind: 'send_back',
      actor: 'Riya',
      reason: 'Missing the budget',
    },
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
      deciders: ['Asha', 'Riya'],
      reasons: [],
    },
  ],
  versions: [],
  approvedVersions: [],
  humanMessages: 4,
  aiMessages: 1,
};

describe('state.md', () => {
  it('renders one section per day, newest first, with decisions in bold, and reads it back', () => {
    let file = mergeState(null, day('2026-10-17'));
    file = mergeState(file, day('2026-10-18', { questions: [] }));
    expect(file.indexOf('## 2026-10-18')).toBeLessThan(file.indexOf('## 2026-10-17'));
    expect(file).toContain('**Decisions**\n\n- **Use Postgres**');
    expect(file).toContain('**Open questions**\n\n- Who owns billing?');
    expect(file).toContain('](progress.md)');
    expect(parseState(file)).toEqual([day('2026-10-18', { questions: [] }), day('2026-10-17')]);
  });

  it('merges updates into their day: the AI rewrites it, recorded facts only add', () => {
    let file = mergeState(null, factsDay('2026-10-18', facts));
    let [today] = parseState(file);
    expect(today?.source).toBe('auto');
    expect(today?.summary).toBe('PLAN was approved and the cycle moved to DESIGN.');
    expect(today?.decisions).toEqual([
      'PLAN gate approved by Asha and Riya, with plan.md: Scope agreed',
      'Sent back DESIGN → PLAN by Riya: Missing the budget',
    ]);

    file = mergeState(file, day('2026-10-18'));
    file = mergeState(file, { ...factsDay('2026-10-18', facts), decisions: ['Ship on Friday'] });
    [today] = parseState(file);
    expect(today).toEqual({ ...day('2026-10-18'), decisions: ['Use Postgres', 'Ship on Friday'] });
    expect(parseState(file)).toHaveLength(1);
  });

  it('parses the AI reply format and drops "none" items', () => {
    expect(
      parseAiState(
        [
          '**SUMMARY:** Design started after PLAN was approved.',
          'DECISIONS:',
          '- Postgres for storage',
          'DISCUSSED:',
          '- none',
          '## Open questions',
          '- Who owns billing?',
        ].join('\n'),
      ),
    ).toEqual({
      summary: 'Design started after PLAN was approved.',
      decisions: ['Postgres for storage'],
      discussed: [],
      questions: ['Who owns billing?'],
    });
    expect(parseAiState('Sure! Here is an update.')).toBeNull();
  });

  it('moves the old AI-written progress log into days', () => {
    const legacy = [
      '# Progress log',
      '',
      '<!-- progress-entry id=m2 at=2026-10-18T12:00:00.000Z -->',
      '## 2026-10-18 12:00 UTC',
      '',
      '_after team discussion · by AI_',
      '',
      'Later talk.',
      '',
      '**Discussions**',
      '',
      '- Pricing: free tier',
      '',
      '<!-- progress-entry id=m1 at=2026-10-18T09:00:00.000Z -->',
      '## 2026-10-18 09:00 UTC',
      '',
      '_after a gate approval · by AI_',
      '',
      'Plan approved.',
      '',
      '**Decisions**',
      '',
      '- Use Postgres',
    ].join('\n');
    expect(legacyStateDays(legacy)).toEqual([
      {
        date: '2026-10-18',
        source: 'ai',
        summary: 'Plan approved. Later talk.',
        decisions: ['Use Postgres'],
        discussed: ['Pricing: free tier'],
        questions: [],
      },
    ]);
  });

  it('opens with the key decisions of every day, newest first, and still parses its days', () => {
    const days = [
      day('2026-10-17', { decisions: ['Use Postgres'] }),
      day('2026-10-18', { decisions: ['Ship login by Friday'] }),
    ];
    const file = renderState(days);
    const top = file.slice(file.indexOf('## Key decisions'), file.indexOf('<!-- state-day'));
    expect(top).toContain(
      '- **2026-10-18** · Ship login by Friday\n- **2026-10-17** · Use Postgres',
    );
    expect(parseState(file).map((d) => d.decisions)).toEqual([
      ['Ship login by Friday'],
      ['Use Postgres'],
    ]);
  });
});
