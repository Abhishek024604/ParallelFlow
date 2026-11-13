import { describe, expect, it } from 'vitest';
import {
  type Extraction,
  ExtractionSchema,
  type MemoryNode,
  parseExtraction,
  PRODUCT_KEY,
} from './model.js';
import { type PlaybookInput, renderPlaybook, renderPlaybookContext } from './playbook.js';
import { type DaySource, resolveDay } from './resolver.js';
import { knownItems } from './memory-store.js';

// Smarter extraction (ADR-045): due dates, architecture decisions, files tied to their Artifact
// node, and the product's vision and scope, with no new node type.

const DAY = '2026-11-13';
const AT = '2026-11-13T18:30:00.000Z';
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};
const node = (
  over: Partial<MemoryNode> & Pick<MemoryNode, 'id' | 'type' | 'key' | 'title'>,
): MemoryNode => ({
  summary: '',
  status: 'active',
  attrs: {},
  firstSeenDay: '2026-11-10',
  lastSeenDay: '2026-11-10',
  ...over,
});
const extraction = (raw: unknown): Extraction => ExtractionSchema.parse(raw);
const sources = new Map<string, DaySource>([
  ['M1', { type: 'message', id: 'msg-1' }],
  ['M2', { type: 'message', id: 'msg-2' }],
  ['F1', { type: 'artifact_version', id: 'art-hld:2' }],
]);
const resolve = (nodes: MemoryNode[], raw: unknown) =>
  resolveDay({
    day: DAY,
    at: AT,
    nodes,
    edges: [],
    extraction: extraction(raw),
    sources,
    newId: ids(),
  });

describe('extraction fields', () => {
  it('accepts due, kind, file and product; refuses a bad date or kind (repairable)', () => {
    const ok = parseExtraction(
      JSON.stringify({
        nodes: [
          { ref: 'n1', type: 'Milestone', title: 'Beta', due: '2026-12-01', refs: ['M1'] },
          {
            ref: 'n2',
            type: 'Decision',
            title: 'Use Postgres',
            kind: 'architecture',
            refs: ['M1'],
          },
          { ref: 'n3', type: 'Artifact', title: 'hld.md', file: 'F1', refs: ['F1'] },
        ],
        product: { vision: 'Parcel tracking for small shops.', refs: ['M2'] },
      }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.nodes[0]).toMatchObject({ due: '2026-12-01', kind: null, file: null });
      expect(ok.value.product).toEqual({
        vision: 'Parcel tracking for small shops.',
        scope: '',
        refs: ['M2'],
      });
    }
    const bad = parseExtraction(
      JSON.stringify({
        nodes: [{ ref: 'n1', type: 'Milestone', title: 'Beta', due: 'next Friday' }],
      }),
    );
    expect(bad).toEqual({ ok: false, error: 'nodes.0.due: invalid string' });
    const kind = parseExtraction(
      JSON.stringify({ nodes: [{ ref: 'n1', type: 'Decision', title: 'X', kind: 'big' }] }),
    );
    expect(kind.ok).toBe(false);
    if (!kind.ok) expect(kind.error).toContain('nodes.0.kind');
  });

  it('keeps due on milestones and actions, kind on decisions, the file on artifacts', () => {
    const plan = resolve([], {
      nodes: [
        { ref: 'n1', type: 'Milestone', title: 'Beta', due: '2026-12-01', refs: ['M1'] },
        { ref: 'n2', type: 'ActionItem', title: 'Write tests', due: '2026-11-20', refs: ['M1'] },
        { ref: 'n3', type: 'Risk', title: 'Late', due: '2026-11-20', refs: ['M1'] },
        { ref: 'n4', type: 'Decision', title: 'Use Postgres', kind: 'architecture', refs: ['M1'] },
        {
          ref: 'n5',
          type: 'Artifact',
          title: 'High-level design',
          summary: 'The HLD',
          refs: ['F1'],
        },
      ],
    });
    expect(plan.creates.map((n) => [n.type, n.attrs])).toEqual([
      ['Milestone', { due: '2026-12-01' }],
      ['ActionItem', { due: '2026-11-20' }],
      ['Risk', {}],
      ['Decision', { kind: 'architecture' }],
      ['Artifact', { artifact_id: 'art-hld' }],
    ]);
  });

  it('matches an Artifact by its file even when the title changed', () => {
    const hld = node({
      id: 'a1',
      type: 'Artifact',
      key: 'hld-md',
      title: 'hld.md',
      attrs: { artifact_id: 'art-hld' },
    });
    const plan = resolve([hld], {
      nodes: [
        {
          ref: 'n1',
          type: 'Artifact',
          title: 'Design document v2',
          summary: 'Services and hosting.',
          file: 'F1',
          refs: ['F1'],
        },
      ],
    });
    expect(plan.creates).toEqual([]);
    expect(plan.updates.map((n) => [n.id, n.summary])).toEqual([['a1', 'Services and hosting.']]);
  });

  it('stores the product vision on one Topic node, replaced by later cited mentions only', () => {
    const first = resolve([], {
      product: { vision: 'Parcel tracking for small shops.', scope: 'Web only', refs: ['M1'] },
    });
    const created = first.creates[0];
    expect(created).toMatchObject({
      type: 'Topic',
      key: PRODUCT_KEY,
      summary: 'Parcel tracking for small shops.',
      attrs: { scope: 'Web only' },
    });
    const existing = node({ ...created!, id: 'p1', type: 'Topic', key: PRODUCT_KEY, title: 'x' });
    expect(resolve([existing], { product: { vision: 'Guess', refs: [] } }).updates).toEqual([]);
    const again = resolve([existing], {
      product: { vision: 'Parcel tracking for shops and couriers.', refs: ['M2'] },
      // A glossary term never lands on the product node.
      nodes: [{ ref: 'n1', type: 'Topic', title: 'Product vision and scope', refs: ['M2'] }],
    });
    expect(again.updates.map((n) => [n.key, n.summary, n.attrs.scope])).toEqual([
      [PRODUCT_KEY, 'Parcel tracking for shops and couriers.', undefined],
    ]);
    expect(again.creates.map((n) => n.key)).toEqual(['product-vision-and-scope']);
    expect(knownItems([existing]).map((k) => k.key)).toEqual([]);
  });
});

describe('the playbook shows them', () => {
  const nodes: MemoryNode[] = [
    node({
      id: 'p',
      type: 'Topic',
      key: PRODUCT_KEY,
      title: 'Product vision and scope',
      summary: 'Parcel tracking for small shops.',
      attrs: { scope: 'Web app; no mobile yet.' },
    }),
    node({
      id: 'd1',
      type: 'Decision',
      key: 'D-001',
      title: 'Host on AWS',
      attrs: { kind: 'architecture', why: 'Data stays in the EU' },
    }),
    node({ id: 'd2', type: 'Decision', key: 'D-002', title: 'Ship weekly' }),
    node({
      id: 'a',
      type: 'Artifact',
      key: 'design-doc',
      title: 'Design doc',
      summary: 'Services and hosting',
      attrs: { artifact_id: 'art-hld' },
    }),
  ];
  const input: PlaybookInput = {
    facts: {
      arenaName: 'TrackFlow',
      description: null,
      createdDay: '2026-11-01',
      cycles: [],
      gate: null,
      members: [],
      files: [
        {
          id: 'art-hld',
          key: 'F-1',
          name: 'hld.md',
          stage: null,
          headVersion: 1,
          approvedVersion: null,
          authors: ['Ravi'],
          updatedDay: '2026-11-12',
        },
      ],
      hasLegacy: false,
    },
    upTo: '2026-11-12',
    story: null,
    nodes,
    edges: [],
  };

  it('in STATE.md: vision and scope, technical decisions, file descriptions by file', () => {
    const md = renderPlaybook(input);
    expect(md).toContain('- **Product:** Parcel tracking for small shops.');
    expect(md).toContain('**Vision:** Parcel tracking for small shops.');
    expect(md).toContain('**In scope:** Web app; no mobile yet.');
    expect(md).toContain('### Technical decisions');
    expect(md).toContain('- **D-001** · Host on AWS — Data stays in the EU');
    expect(md.slice(md.indexOf('## 6. Architecture'), md.indexOf('## 7.'))).not.toContain(
      'Ship weekly',
    );
    expect(md).toContain('| F-1 | hld.md | Services and hosting |');
    expect(md.slice(md.indexOf('## Glossary'))).not.toContain('Product vision');
  });

  it('in the linked chat context', () => {
    const text = renderPlaybookContext(input, []);
    expect(text).toContain('Vision: Parcel tracking for small shops.');
    expect(text).toContain('In scope: Web app; no mobile yet.');
    expect(text).toContain('- D-001 · Host on AWS (technical decision)');
    expect(text).toContain('- F-1 · hld.md · v1 draft — Services and hosting');
  });
});
