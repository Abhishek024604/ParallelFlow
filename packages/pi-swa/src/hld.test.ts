import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { approveGate } from './approve.js';
import { saveDiagrams, syncDiagram } from './diagram-tools.js';
import {
  diagramDiff,
  generatedUntouched,
  modelViews,
  picture,
  readDrawio,
  toDrawio,
  toExcalidraw,
} from './diagrams.js';
import { parseModel } from './model.js';
import { swaResources } from './resources.js';
import { canStart, snapshot } from './state.js';
import { MemoryArchStore } from './store.js';
import { renderTrace, trace } from './trace.js';

const md = (id: string, body = 'Text.', extra = '') =>
  `---\nid: ${id}\nstatus: draft\nversion: 1\nowner: architect\ninputs: [inputs/srs.md]\n${extra}---\n\n# ${id}\n\n${body}\n`;

const MODEL = `version: 1
system: { name: Shop }
actors: [{ id: customer, name: Customer }]
externals: [{ id: psp, name: Payment provider }]
components:
  - { id: CMP-001, name: web-app, kind: ui, tech: React, satisfies: [FR-001] }
  - { id: CMP-002, name: order-service, kind: service, tech: Node.js, satisfies: [FR-001, NFR-001], adrs: [ADR-0001], code: [apps/orders/**] }
  - { id: CMP-003, name: orders-db, kind: database, tech: PostgreSQL, satisfies: [NFR-001] }
relations:
  - { from: customer, to: CMP-001, label: uses }
  - { from: CMP-001, to: CMP-002, label: REST }
  - { from: CMP-002, to: CMP-003, label: SQL }
  - { from: CMP-002, to: psp, label: charges, kind: async }
flows:
  - id: checkout
    name: Checkout
    steps:
      - { from: customer, to: CMP-001, label: places order }
      - { from: CMP-001, to: CMP-002, label: POST /orders }
deployment:
  - { id: prod, name: Production, kind: cluster, contains: [CMP-001, CMP-002, CMP-003] }
`;

const DRIVERS = md(
  'DRIVERS',
  '| ID | Requirement |\n| --- | --- |\n| FR-001 | Order |\n| FR-002 | Refund |\n| NFR-001 | p95 < 300 ms |\n| CON-001 | EU only |',
);

/** A project past G1, with drivers, stack, ADR-0001 and the model. */
async function pastG1(extra: Record<string, string> = {}) {
  const store = new MemoryArchStore({
    'inputs/srs.md': '# SRS',
    'inputs/goal.md': '# Goals',
    '00-drivers.md': DRIVERS,
    'stack.md': md(
      'STACK',
      'ADR-0001. SEC-TLS SEC-SECRETS SEC-AUTHN SEC-AUTHZ SEC-INPUT SEC-LOGS SEC-DEPS STD-NAME-SERVICES STD-API-CONTRACT STD-API-VERSION STD-OBS STD-HEALTH',
      'stack:\n  - { layer: data, tech: PostgreSQL, adr: ADR-0001 }\n',
    ),
    'decisions/ADR-0001-architecture-style.md': md('ADR-0001'),
    ...extra,
  });
  expect((await approveGate(store, 'G0', 'A', swaResources())).ok).toBe(true);
  expect((await approveGate(store, 'G1', 'A', swaResources())).ok).toBe(true);
  await store.write('model.yaml', MODEL);
  return store;
}

describe('the component model', () => {
  it('parses components, relations, flows and deployment', () => {
    const { model, problems } = parseModel(MODEL);
    expect(problems).toEqual([]);
    expect(model.components.map((c) => c.id)).toEqual(['CMP-001', 'CMP-002', 'CMP-003']);
    expect(model.flows[0]?.steps).toHaveLength(2);
    expect(modelViews(model).map((v) => v.path)).toEqual([
      'hld/context.drawio',
      'hld/containers.drawio',
      'hld/deployment.drawio',
      'hld/flows/checkout.drawio',
    ]);
  });

  it('reports bad ids, unknown references and components that satisfy nothing', () => {
    const { problems } = parseModel(
      'components:\n  - { id: api, name: api }\nrelations:\n  - { from: api, to: CMP-009 }\n',
    );
    expect(problems).toContain('component id "api" must look like CMP-001');
    expect(problems).toContain('api satisfies no requirement (add FR/NFR/CON ids to `satisfies`)');
    expect(problems).toContain('relation api → CMP-009: unknown id CMP-009');
  });
});

describe('diagrams from the model', () => {
  const { model } = parseModel(MODEL);

  it('draws each view with the model ids as cell ids', () => {
    const containers = toDrawio(picture(model, 'containers'), 'containers');
    const cells = readDrawio(containers);
    expect(cells.filter((c) => c.vertex).map((c) => c.id)).toEqual([
      'title',
      'customer',
      'CMP-001',
      'CMP-002',
      'CMP-003',
      'psp',
    ]);
    expect(cells.find((c) => c.id === 'CMP-002')?.label).toBe('order-service');
    expect(cells.filter((c) => !c.vertex)).toHaveLength(4);
    // Context folds the components into the system box and keeps only outside relations.
    const context = readDrawio(toDrawio(picture(model, 'context'), 'context'));
    expect(context.filter((c) => !c.vertex).map((c) => `${c.source}>${c.target}`)).toEqual([
      'customer>SYSTEM',
      'SYSTEM>psp',
    ]);
    const deployment = readDrawio(toDrawio(picture(model, 'deployment'), 'deployment'));
    expect(deployment.map((c) => c.id)).toContain('prod/CMP-002');
    const flow = readDrawio(toDrawio(picture(model, 'flow', 'checkout'), 'checkout'));
    expect(flow.filter((c) => !c.vertex).map((c) => c.label)).toEqual([
      '1. places order',
      '2. POST /orders',
    ]);
  });

  it('knows a generated file from an edited one', () => {
    const xml = toDrawio(picture(model, 'containers'), 'containers');
    expect(generatedUntouched(xml)).toBe(true);
    expect(generatedUntouched(xml.replace('x="40"', 'x="45"'))).toBe(false);
  });

  it('reads an edited (and compressed) draw.io file back and reports the differences', () => {
    const xml = toDrawio(picture(model, 'containers'), 'containers')
      .replace('&lt;b&gt;orders-db&lt;/b&gt;', '&lt;b&gt;order-store&lt;/b&gt;')
      .replace(
        '</root>',
        '<mxCell id="x1" value="Cache" style="rounded=1;" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell><mxCell id="x2" value="REST" style="edgeLabel;" vertex="1" parent="1"><mxGeometry as="geometry"/></mxCell></root>',
      );
    const graph = /<mxGraphModel[\s\S]*<\/mxGraphModel>/.exec(xml)?.[0] ?? '';
    const packed = deflateRawSync(Buffer.from(encodeURIComponent(graph))).toString('base64');
    const compressed = `<mxfile><diagram id="d" name="p">${packed}</diagram></mxfile>`;
    for (const file of [xml, compressed]) {
      expect(diagramDiff(picture(model, 'containers'), file)).toEqual([
        'renamed in the diagram: CMP-003 is "order-store", the model says "orders-db"',
        'added in the diagram, not in the model: "Cache"',
      ]);
    }
  });

  it('writes an Excalidraw sketch with bound labels and arrows', () => {
    const sketch = JSON.parse(toExcalidraw(picture(model, 'containers'))) as {
      type: string;
      elements: { id: string; type: string; containerId?: string; startBinding?: unknown }[];
    };
    expect(sketch.type).toBe('excalidraw');
    expect(sketch.elements.find((e) => e.id === 'CMP-002')?.type).toBe('rectangle');
    expect(sketch.elements.find((e) => e.id === 'CMP-002:label')?.containerId).toBe('CMP-002');
    expect(sketch.elements.filter((e) => e.type === 'arrow')).toHaveLength(4);
  });
});

describe('HLD tools', () => {
  it('saves every view through the write rules, and keeps an edited diagram', async () => {
    const store = await pastG1();
    const first = await saveDiagrams(store, {});
    expect(first.split('\n')).toEqual([
      'Created arch/hld/context.drawio.',
      'Created arch/hld/containers.drawio.',
      'Created arch/hld/deployment.drawio.',
      'Created arch/hld/flows/checkout.drawio.',
    ]);
    expect(await saveDiagrams(store, { view: 'context' })).toBe(
      'arch/hld/context.drawio is up to date.',
    );

    const edited = (store.files.get('hld/containers.drawio') ?? '').replace(
      '&lt;b&gt;web-app&lt;/b&gt;',
      '&lt;b&gt;storefront&lt;/b&gt;',
    );
    store.files.set('hld/containers.drawio', edited);
    const kept = await saveDiagrams(store, { view: 'containers' });
    expect(kept).toContain('Kept arch/hld/containers.drawio');
    expect(kept).toContain('CMP-001 is "storefront"');
    expect(store.files.get('hld/containers.drawio')).toBe(edited);
    expect(await syncDiagram(store, 'arch/hld/containers.drawio')).toContain(
      'differs from model.yaml',
    );
    expect(await saveDiagrams(store, { view: 'containers', replace: true })).toBe(
      'Updated arch/hld/containers.drawio.',
    );
    expect(await saveDiagrams(store, { format: 'excalidraw', view: 'containers' })).toBe(
      'Created arch/hld/sketches/containers.excalidraw.',
    );
  });

  it('draws before G1 is approved (approvals are optional)', async () => {
    const store = new MemoryArchStore({
      'inputs/srs.md': '# SRS',
      'inputs/goal.md': '# Goals',
      'model.yaml': MODEL,
    });
    expect(await saveDiagrams(store, { view: 'context' })).not.toContain('needs gate');
  });

  it('traces requirements to components, ADRs and code, with the gaps', async () => {
    const store = await pastG1();
    const report = await trace(store);
    expect(report?.rows.find((r) => r.requirement === 'FR-001')).toEqual({
      requirement: 'FR-001',
      components: ['CMP-001', 'CMP-002'],
      adrs: ['ADR-0001'],
      code: ['apps/orders/**'],
    });
    expect(report?.unsatisfied).toEqual(['FR-002']);
    const text = renderTrace(report);
    expect(text).toContain('Traceability: 2 of 4 requirements map to a component.');
    expect(text).toContain('GAP: no component satisfies FR-002.');
  });

  it('notes a missing HLD for the review, without blocking it', async () => {
    const store = await pastG1();
    expect(canStart(await snapshot(store), 'review-design').notes?.join(' ')).toContain(
      'No arch/hld/hld.md yet',
    );
    await store.write('hld/hld.md', md('HLD'));
    expect(canStart(await snapshot(store), 'review-design')).toEqual({ ok: true });
  });
});
