import { describe, expect, it } from 'vitest';
import { type Extraction, ExtractionSchema, type MemoryNode } from './model.js';
import { type DaySource, resolveDay } from './resolver.js';

const DAY = '2026-11-03';
const AT = '2026-11-03T18:30:00.000Z';

function ids() {
  let n = 0;
  return () => `id-${++n}`;
}

const node = (
  over: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'type' | 'key' | 'title'>,
): MemoryNode => ({
  summary: '',
  status: 'active',
  attrs: {},
  firstSeenDay: '2026-11-01',
  lastSeenDay: '2026-11-01',
  ...over,
});

const extraction = (raw: unknown): Extraction => ExtractionSchema.parse(raw);

const sources = new Map<string, DaySource>([
  ['M1', { type: 'message', id: 'msg-1' }],
  ['M2', { type: 'message', id: 'msg-2' }],
  ['E1', { type: 'event', id: '42' }],
]);

describe('resolveDay', () => {
  it('creates new items with the next keys, people by name, and their sources', () => {
    const plan = resolveDay({
      day: DAY,
      at: AT,
      nodes: [node({ id: 'd1', type: 'Decision', key: 'D-002', title: 'Ship weekly' })],
      edges: [],
      extraction: extraction({
        nodes: [
          { ref: 'n1', type: 'Decision', title: 'Use Postgres for events', refs: ['M1'] },
          { ref: 'n2', type: 'Person', title: 'Asha Rao', roles: ['Owner'], refs: ['M1'] },
          { ref: 'n3', type: 'Question', title: 'Which region do we host in?', refs: ['M2'] },
        ],
        edges: [{ from: 'n1', to: 'n2', type: 'DECIDED_BY', refs: ['M1'] }],
      }),
      sources,
      newId: ids(),
    });
    expect(plan.creates.map((n) => [n.type, n.key, n.status])).toEqual([
      ['Decision', 'D-003', 'active'],
      ['Person', 'asha-rao', 'active'],
      ['Question', 'Q-001', 'open'],
    ]);
    expect(plan.creates[0]?.attrs.by).toBe('Asha Rao');
    expect(plan.edges).toHaveLength(1);
    expect(plan.sources.filter((s) => s.nodeId).map((s) => s.source.id)).toEqual([
      'msg-1',
      'msg-1',
      'msg-2',
    ]);
    expect(plan.delta.every((d) => d.change === 'new')).toBe(true);
  });

  it('merges the same item said again (by key or by a close title) instead of duplicating', () => {
    const existing = [
      node({ id: 'd1', type: 'Decision', key: 'D-001', title: 'Use Postgres for the event store' }),
      node({ id: 'p1', type: 'Person', key: 'asha', title: 'Asha' }),
    ];
    const plan = resolveDay({
      day: DAY,
      at: AT,
      nodes: existing,
      edges: [{ id: 'e1', src: 'd1', dst: 'p1', type: 'DECIDED_BY', confidence: 1 }],
      extraction: extraction({
        nodes: [
          {
            ref: 'n1',
            type: 'Decision',
            title: 'use postgres event store',
            summary: 'Postgres 16 with RLS',
            refs: ['M2'],
          },
          { ref: 'n2', type: 'Person', key: 'asha', title: 'Asha', refs: ['M2'] },
        ],
        edges: [{ from: 'n1', to: 'asha', type: 'DECIDED_BY', refs: ['M2'] }],
      }),
      sources,
      newId: ids(),
    });
    expect(plan.creates).toEqual([]);
    expect(plan.edges).toEqual([]); // the live edge is reused
    expect(plan.sources.find((s) => s.edgeId === 'e1')?.source.id).toBe('msg-2');
    const d = plan.updates.find((n) => n.id === 'd1');
    expect(d).toMatchObject({ summary: 'Postgres 16 with RLS', lastSeenDay: DAY });
    expect(plan.delta).toEqual([
      expect.objectContaining({ change: 'updated', key: 'D-001', summary: 'Postgres 16 with RLS' }),
    ]);
  });

  it('supersedes within a type only, closing the old item and linking the new one', () => {
    const existing = [
      node({ id: 'd1', type: 'Decision', key: 'D-001', title: 'Host on Heroku' }),
      node({ id: 'r1', type: 'Instruction', key: 'RULE-001', title: 'Version APIs under /v1' }),
    ];
    const plan = resolveDay({
      day: DAY,
      at: AT,
      nodes: existing,
      edges: [],
      extraction: extraction({
        nodes: [{ ref: 'n1', type: 'Decision', title: 'Host on AWS', refs: ['M1'] }],
        supersedes: [
          { new: 'n1', old: 'D-001', refs: ['M1'] },
          { new: 'n1', old: 'RULE-001', refs: ['M1'] },
        ],
      }),
      sources,
      newId: ids(),
    });
    const old = plan.updates.find((n) => n.id === 'd1');
    expect(old).toMatchObject({ status: 'superseded', validTo: AT });
    expect(plan.updates.find((n) => n.id === 'r1')).toBeUndefined();
    expect(plan.edges).toEqual([
      expect.objectContaining({ src: 'id-1', dst: 'd1', type: 'SUPERSEDES' }),
    ]);
    expect(plan.delta.find((d) => d.key === 'D-002')?.replaced).toEqual({
      key: 'D-001',
      title: 'Host on Heroku',
    });
  });

  it('flags an uncertain or unsourced item for confirmation, and clears it when confirmed', () => {
    const first = resolveDay({
      day: DAY,
      at: AT,
      nodes: [],
      edges: [],
      extraction: extraction({
        nodes: [
          {
            ref: 'n1',
            type: 'Risk',
            title: 'Vendor may raise prices',
            refs: ['M1'],
            confidence: 0.4,
          },
          { ref: 'n2', type: 'Decision', title: 'Launch in March', refs: ['M9'] },
        ],
      }),
      sources,
      newId: ids(),
    });
    // M9 is not a source of the day: capped below the threshold.
    expect(first.creates.map((n) => !!n.attrs.needs_confirmation)).toEqual([true, true]);
    expect(first.sources).toEqual([
      expect.objectContaining({ source: { type: 'message', id: 'msg-1' } }),
    ]);

    const risk = { ...first.creates[0]!, attrs: { ...first.creates[0]!.attrs } };
    const second = resolveDay({
      day: '2026-11-04',
      at: AT,
      nodes: [risk],
      edges: [],
      extraction: extraction({
        nodes: [
          {
            ref: 'n1',
            type: 'Risk',
            key: risk.key,
            title: risk.title,
            refs: ['E1'],
            confidence: 0.9,
          },
        ],
      }),
      sources,
      newId: ids(),
    });
    expect(second.updates[0]?.attrs.needs_confirmation).toBeUndefined();
  });

  it('moves items on only along their type rules', () => {
    const existing = [
      node({ id: 'q1', type: 'Question', key: 'Q-001', title: 'Which region?', status: 'open' }),
      node({ id: 'd1', type: 'Decision', key: 'D-001', title: 'Use Postgres' }),
    ];
    const plan = resolveDay({
      day: DAY,
      at: AT,
      nodes: existing,
      edges: [],
      extraction: extraction({
        status_changes: [
          { key: 'Q-001', status: 'resolved', refs: ['M1'] },
          { key: 'D-001', status: 'done', refs: ['M1'] },
        ],
      }),
      sources,
      newId: ids(),
    });
    expect(plan.updates.map((n) => [n.key, n.status])).toEqual([['Q-001', 'resolved']]);
    expect(plan.delta).toEqual([expect.objectContaining({ change: 'status', key: 'Q-001' })]);
  });
});
