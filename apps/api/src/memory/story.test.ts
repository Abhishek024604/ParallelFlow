import { describe, expect, it } from 'vitest';
import type { MemoryEdge, MemoryNode } from './model.js';
import { factsChapter, deltaLine } from './prompts.js';
import { dayRange, isMemoryStory, renderGraphJson } from './story.js';

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
describe('STATE.md helpers', () => {
  it('formats day ranges', () => {
    expect(dayRange('2026-10-30', '2026-11-02')).toBe('30 Oct – 2 Nov 2026');
    expect(dayRange('2026-12-30', '2027-01-02')).toBe('30 Dec 2026 – 2 Jan 2027');
  });

  it('knows a memory-written STATE.md by its marker', () => {
    expect(isMemoryStory('# x\n<!-- memory-story -->\n')).toBe(true);
    expect(isMemoryStory('# old state')).toBe(false);
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
