import { describe, expect, it } from 'vitest';
import type { MemoryEdge, MemoryNode } from './model.js';
import { factsChapter, deltaLine } from './prompts.js';
import { type Chapter, dayRange, isMemoryStory, renderGraphJson, renderStory } from './story.js';

const node = (
  over: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'type' | 'key' | 'title'>,
): MemoryNode => ({
  summary: '',
  status: 'active',
  attrs: {},
  firstSeenDay: '2026-10-21',
  lastSeenDay: '2026-10-21',
  ...over,
});

const nodes: MemoryNode[] = [
  node({ id: 'p1', type: 'Person', key: 'asha', title: 'Asha', attrs: { roles: ['Owner'] } }),
  node({ id: 'p2', type: 'Person', key: 'ravi', title: 'Ravi' }),
  node({ id: 'd1', type: 'Decision', key: 'D-001', title: 'Host on Heroku', status: 'superseded' }),
  node({
    id: 'd2',
    type: 'Decision',
    key: 'D-002',
    title: 'Host on AWS | eu-west-1',
    attrs: { why: 'Data must stay in the EU' },
    firstSeenDay: '2026-10-22',
  }),
  node({
    id: 'r1',
    type: 'Instruction',
    key: 'RULE-001',
    title: 'Version every API under /v1',
    attrs: { by: 'Asha' },
  }),
  node({
    id: 'q1',
    type: 'Question',
    key: 'Q-001',
    title: 'Which payment provider?',
    status: 'open',
  }),
  node({ id: 'q2', type: 'Question', key: 'Q-002', title: 'Answered one', status: 'resolved' }),
  node({ id: 'a1', type: 'ActionItem', key: 'A-001', title: 'Draft the API spec', status: 'open' }),
  node({
    id: 'k1',
    type: 'Risk',
    key: 'RISK-001',
    title: 'Vendor lock-in',
    status: 'open',
    attrs: { needs_confirmation: true },
  }),
  node({ id: 't1', type: 'Topic', key: 'gate', title: 'Gate', summary: 'A stage approval' }),
];
const edges: MemoryEdge[] = [
  { id: 'e1', src: 'd2', dst: 'p1', type: 'DECIDED_BY', confidence: 1 },
  { id: 'e2', src: 'd2', dst: 'd1', type: 'SUPERSEDES', confidence: 1 },
  { id: 'e3', src: 'a1', dst: 'p2', type: 'ASSIGNED_TO', confidence: 1 },
];
const chapters: Chapter[] = [
  {
    day: '2026-10-23',
    status: 'done',
    title: 'Design starts',
    chapter: 'Ravi drew the HLD.',
    stage: 'DESIGN',
    cycle: 1,
  },
  {
    day: '2026-10-21',
    status: 'done',
    title: 'The idea',
    chapter: 'Asha opened the arena [D-001].',
    stage: 'PLAN',
    cycle: 1,
  },
  {
    day: '2026-10-22',
    status: 'failed',
    title: 'What was recorded',
    chapter: '- a fact',
    stage: 'PLAN',
    cycle: 1,
  },
  { day: '2026-10-24', status: 'quiet', title: null, chapter: null, stage: 'DESIGN', cycle: 1 },
];

describe('STATE.md, the story', () => {
  const md = renderStory({
    arenaName: 'TrackFlow',
    upTo: '2026-10-24',
    story: 'TrackFlow tracks parcels.',
    nodes,
    edges,
    chapters,
    legacy: [{ date: '2026-10-20', summary: 'Old notes.' }],
  });

  it('has every section, in order', () => {
    expect(isMemoryStory(md)).toBe(true);
    const order = [
      '# The story of TrackFlow',
      '> Up to 24 Oct 2026.',
      '## The story so far',
      'TrackFlow tracks parcels.',
      '## Ground rules',
      '## Key decisions',
      '## Who’s who',
      '## Open threads',
      '## Needs confirmation',
      '## Chapters',
      '## Glossary',
    ];
    let at = -1;
    for (const part of order) {
      const next = md.indexOf(part);
      expect(next, part).toBeGreaterThan(at);
      at = next;
    }
  });

  it('fills the sections from the graph', () => {
    expect(md).toContain(
      '- **RULE-001** · Version every API under /v1 _(set by Asha, 21 Oct 2026)_',
    );
    // Newest decision first, pipes escaped, who and what it replaced.
    expect(md).toContain(
      '| D-002 | Host on AWS \\| eu-west-1 | Data must stay in the EU | Asha | 22 Oct 2026 | active | D-001 |',
    );
    expect(md.indexOf('| D-002')).toBeLessThan(md.indexOf('| D-001'));
    expect(md).toContain('- **Asha** · Owner — decided D-002');
    expect(md).toContain('- **Ravi** — working on A-001');
    expect(md).toContain('**Q-001** · Which payment provider?');
    expect(md).not.toContain('Answered one');
    expect(md).toContain('**A-001** · Draft the API spec → Ravi');
    expect(md).toMatch(/## Needs confirmation[\s\S]*RISK-001\*\* · Vendor lock-in \(Risk/);
    expect(md).toContain('- **Gate** — A stage approval');
  });

  it('tells the chapters oldest first, by stage, quiet days left out', () => {
    expect(md).toContain('### Before the memory');
    expect(md).toContain('### Chapter 1 · Plan (21–22 Oct 2026)');
    expect(md).toContain('### Chapter 2 · Design (23 Oct 2026)');
    expect(md.indexOf('The idea')).toBeLessThan(md.indexOf('What was recorded'));
    expect(md).toContain('_Told from the recorded facts: the AI will retell this day._');
    expect(md).not.toContain('24 Oct 2026 ·');
  });

  it('keeps the written chapters as they are when later days are added (append-only)', () => {
    const later = renderStory({
      arenaName: 'TrackFlow',
      upTo: '2026-10-25',
      story: 'Newer story.',
      nodes,
      edges,
      chapters: [
        ...chapters,
        {
          day: '2026-10-25',
          status: 'done',
          title: 'Build begins',
          chapter: 'Code lands.',
          stage: 'BUILD',
          cycle: 1,
        },
      ],
      legacy: null,
    });
    const earlier = md.slice(md.indexOf('### Chapter 1'), md.indexOf('## Glossary'));
    expect(later).toContain(earlier.trim());
    expect(later).toContain('### Chapter 3 · Build (25 Oct 2026)');
  });

  it('starts empty before the first night', () => {
    const empty = renderStory({
      arenaName: 'New',
      upTo: null,
      story: null,
      nodes: [],
      edges: [],
      chapters: [],
      legacy: null,
    });
    expect(empty).toContain('Nothing to tell yet.');
    expect(empty).toContain('The first chapter is written after the arena’s first day ends.');
  });

  it('formats day ranges', () => {
    expect(dayRange('2026-10-30', '2026-11-02')).toBe('30 Oct – 2 Nov 2026');
    expect(dayRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });
});

describe('graph.json and the fallback chapter', () => {
  it('names nodes readably and keeps sources as ids', () => {
    const json = JSON.parse(
      renderGraphJson({
        arenaName: 'TrackFlow',
        upTo: '2026-10-24',
        nodes,
        edges,
        sources: [{ nodeId: 'd2', edgeId: null, type: 'message', id: 'm-1' }],
      }),
    );
    expect(json.edges).toContainEqual({
      from: 'Decision:D-002',
      type: 'SUPERSEDES',
      to: 'Decision:D-001',
      confidence: 1,
    });
    expect(json.sources['Decision:D-002']).toEqual([{ type: 'message', id: 'm-1' }]);
    expect(json.nodes.find((n: { key: string }) => n.key === 'RISK-001').needs_confirmation).toBe(
      true,
    );
  });

  it('tells a day from the facts when the AI cannot', () => {
    const delta = [
      {
        change: 'new' as const,
        type: 'Decision' as const,
        key: 'D-003',
        title: 'Use Postgres',
        summary: '',
        status: 'active' as const,
        needsConfirmation: false,
      },
    ];
    expect(deltaLine(delta[0]!)).toBe('- new Decision D-003 · Use Postgres');
    const told = factsChapter(delta, [{ ref: 'E1', time: '14:02', line: 'Asha approved gate' }]);
    expect(told.chapter).toBe('- new Decision D-003 · Use Postgres\n- 14:02 · Asha approved gate');
  });
});
