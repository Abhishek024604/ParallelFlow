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

describe('STATE.md', () => {
  it('renders one section per day, newest first, lists each fact once, and reads it back', () => {
    let file = mergeState(null, day('2026-10-17'));
    file = mergeState(file, day('2026-10-18', { questions: [] }));
    const days = file.slice(file.indexOf('## Day by day'));
    expect(days.indexOf('### Sunday, 18 October 2026')).toBeLessThan(
      days.indexOf('### Saturday, 17 October 2026'),
    );
    expect(days).toContain('### Sunday, 18 October 2026\n\n> Work on 2026-10-18.');
    expect(days).toContain('**Discussed**\n\n- Pricing: free tier stays');
    // Decisions and questions are shown once, at the top, not again in each day (they are kept as
    // data on the day, in a comment the viewer does not show).
    const shown = file.replace(/^<!--[^\n]*-->$/gm, '');
    const shownDays = shown.slice(shown.indexOf('## Day by day'));
    expect(shownDays).not.toContain('Use Postgres');
    expect(shownDays).not.toContain('Who owns billing?');
    expect(shown.match(/Use Postgres/g)).toHaveLength(2); // once per day, under its date
    expect(shown.match(/Who owns billing\?/g)).toHaveLength(1);
    expect(file).toContain('](PROGRESS.md)');
    expect(parseState(file)).toEqual([day('2026-10-18', { questions: [] }), day('2026-10-17')]);
  });

  it('merges updates into their day: the AI rewrites it, recorded facts only add', () => {
    let file = mergeState(null, factsDay('2026-10-18', facts));
    expect(file).toContain('the AI could not summarise this day');
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

  it('opens with key decisions by date and the latest open questions, and still parses its days', () => {
    const days = [
      day('2026-10-17', { decisions: ['Use Postgres'] }),
      day('2026-10-18', { decisions: ['Ship login by Friday'], questions: [] }),
    ];
    const file = renderState(days);
    expect(file).toContain(
      '**At a glance:** 2 key decisions · 1 open question · 2 days recorded · last updated Sunday, 18 October 2026',
    );
    const top = file.slice(file.indexOf('## Key decisions'), file.indexOf('## Open questions'));
    expect(top).toContain(
      '### Sunday, 18 October 2026\n\n- **Ship login by Friday**\n\n### Saturday, 17 October 2026\n\n- **Use Postgres**',
    );
    // The latest day with open questions.
    expect(file).toContain(
      '## Open questions\n\n_As of Saturday, 17 October 2026_\n\n- Who owns billing?',
    );
    expect(parseState(file).map((d) => d.decisions)).toEqual([
      ['Ship login by Friday'],
      ['Use Postgres'],
    ]);
  });

  it('still reads days written in the old layout', () => {
    const old = [
      '# Arena state',
      '',
      '<!-- state-day date=2026-10-18 source=ai -->',
      '## 2026-10-18',
      '',
      'Plan approved.',
      '',
      '**Decisions**',
      '',
      '- **Use Postgres**',
    ].join('\n');
    expect(parseState(old)).toEqual([
      day('2026-10-18', { summary: 'Plan approved.', discussed: [], questions: [] }),
    ]);
  });
});
