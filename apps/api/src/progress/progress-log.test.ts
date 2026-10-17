import { describe, expect, it } from 'vitest';
import {
  factsEntry,
  lastEntryAt,
  mergeLog,
  parseAiProgress,
  parseLog,
  type ProgressEntry,
  type ProgressFacts,
  renderProgressFile,
} from './progress-log.js';

const facts: ProgressFacts = {
  since: null,
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
    },
  ],
  documents: [{ name: 'plan.md', version: 2, approved: true }],
  humanMessages: 12,
  aiMessages: 3,
};

const entry = (id: string, at: string, summary: string): ProgressEntry => ({
  id,
  at,
  cycle: 1,
  stage: 'DESIGN',
  trigger: 'messages',
  source: 'ai',
  summary,
  decisions: ['Use Postgres'],
  timeline: ['Beta on 1 Nov'],
  discussions: ['Pricing: free tier stays'],
});

describe('progress log', () => {
  it('builds a plain entry from the facts', () => {
    const plain = factsEntry({ id: 'gate:a1', at: '2026-10-18T10:00:01Z', trigger: 'gate' }, facts);
    expect(plain.source).toBe('auto');
    expect(plain.summary).toContain('PLAN → DESIGN');
    expect(plain.summary).toContain('12 messages from the team');
    expect(plain.decisions).toEqual(['PLAN gate approved with plan.md: Scope agreed']);
    expect(plain.timeline[0]).toContain('Cycle 1 · PLAN → DESIGN · approved by Asha');
  });

  it('keeps entries newest first and replaces an entry with the same id', () => {
    let log = mergeLog(null, entry('m1', '2026-10-18T09:00:00.000Z', 'First'));
    log = mergeLog(log, entry('gate:a1', '2026-10-18T10:00:00.000Z', 'Plain gate entry'));
    log = mergeLog(log, entry('gate:a1', '2026-10-18T10:00:00.000Z', 'AI gate entry'));
    const entries = parseLog(log);
    expect(entries.map((e) => e.id)).toEqual(['gate:a1', 'm1']);
    expect(log).toContain('AI gate entry');
    expect(log).not.toContain('Plain gate entry');
    expect(log).toContain('**Decisions**\n\n- Use Postgres');
    expect(lastEntryAt(log, 'gate:a1')).toBe('2026-10-18T09:00:00.000Z');
  });

  it('parses the AI reply format and drops "none" items', () => {
    const parsed = parseAiProgress(
      [
        '**SUMMARY:** Design started after PLAN was approved.',
        'DECISIONS:',
        '- Postgres for storage',
        'TIMELINE:',
        '- none',
        'DISCUSSIONS:',
        '- Pricing: keep a free tier',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      summary: 'Design started after PLAN was approved.',
      decisions: ['Postgres for storage'],
      timeline: [],
      discussions: ['Pricing: keep a free tier'],
    });
    expect(parseAiProgress('Sure! Here is an update.')).toBeNull();
  });

  it('renders progress.md with the log, the stage moves and the approved files', () => {
    const log = mergeLog(null, entry('m1', '2026-10-18T09:00:00.000Z', 'First'));
    const file = renderProgressFile({
      log,
      current: { number: 1, stage: 'DESIGN', status: 'active' },
      moves: facts.moves,
      approvedFiles: ['cycle-1/plan/plan.md'],
    });
    expect(file).toContain('## Log\n\n### 2026-10-18 09:00 UTC · Cycle 1 · DESIGN');
    expect(file).not.toContain('progress-entry');
    expect(file).toContain('## Stage moves\n\n- 2026-10-18 10:00 UTC · Cycle 1 · PLAN → DESIGN');
    expect(file).toContain('- [cycle-1/plan/plan.md](cycle-1/plan/plan.md)');
  });
});
