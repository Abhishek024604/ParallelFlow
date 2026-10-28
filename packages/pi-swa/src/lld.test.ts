import { describe, expect, it } from 'vitest';
import { approveGate } from './approve.js';
import { asyncapiEvents, checkLld, openapiOperations, usedFromNeighbours } from './lld.js';
import { swaResources } from './resources.js';
import { snapshot } from './state.js';
import { MemoryArchStore } from './store.js';
import { planWrite } from './writes.js';

const md = (id: string, body = 'Text.', extra = '') =>
  `---\nid: ${id}\nstatus: draft\nversion: 1\nowner: architect\ninputs: [model.yaml]\n${extra}---\n\n# ${id}\n\n${body}\n`;

const MODEL = `components:
  - { id: CMP-001, name: web-app, kind: ui, satisfies: [FR-001] }
  - { id: CMP-002, name: order-service, kind: service, satisfies: [FR-001] }
  - { id: CMP-003, name: orders-db, kind: database, satisfies: [FR-001] }
  - { id: CMP-004, name: billing, kind: service, satisfies: [FR-001] }
relations:
  - { from: CMP-001, to: CMP-002, label: REST }
  - { from: CMP-002, to: CMP-003, label: SQL }
  - { from: CMP-002, to: CMP-004, label: OrderPlaced, kind: async }
`;

const OPENAPI = `openapi: 3.1.0
info: { title: orders, version: '1' }
paths:
  /orders:
    post: { summary: Place an order (FR-001) }
  /orders/{orderId}:
    get: { summary: Read one }
`;

const ASYNCAPI = `asyncapi: 3.0.0
info: { title: orders, version: '1' }
channels:
  orders:
    messages:
      OrderPlaced: { name: OrderPlaced }
`;

/** A project with an approved baseline (G0-G2). */
async function baseline() {
  const drivers = md('DRIVERS', '| ID | R |\n| --- | --- |\n| FR-001 | Order |');
  const store = new MemoryArchStore({
    'inputs/srs.md': '# SRS',
    'inputs/goal.md': '# Goals',
    '00-drivers.md': drivers,
    'stack.md': md('STACK'),
    'model.yaml': MODEL,
    'hld/hld.md': md('HLD'),
    'reviews/hld-review.md': md('HLD-REVIEW'),
  });
  for (const g of ['G0', 'G1', 'G2']) expect((await approveGate(store, g, 'A')).ok).toBe(true);
  return store;
}

describe('contracts', () => {
  it('reads OpenAPI operations and AsyncAPI events', () => {
    expect([...openapiOperations(OPENAPI)]).toEqual(['POST /orders', 'GET /orders/{orderId}']);
    expect([...asyncapiEvents(ASYNCAPI)]).toEqual(['orders', 'OrderPlaced']);
  });

  it('reads what an LLD uses from its neighbours', () => {
    expect(
      usedFromNeighbours(
        '| CMP-002 | POST /orders | place |\n| CMP-004 | event `OrderPlaced` | bill |',
      ),
    ).toEqual([
      { component: 'CMP-002', op: 'POST /orders' },
      { component: 'CMP-004', event: 'OrderPlaced' },
    ]);
  });
});

describe('LLD per component', () => {
  it('is written only for a component of the approved HLD', async () => {
    const store = await baseline();
    const write = (path: string) =>
      snapshot(store).then((s) => planWrite(store, s, { path, content: md('LLD') }));
    expect(await write('lld/CMP-002/lld.md')).toMatchObject({ ok: true });
    const missing = await write('lld/CMP-009/lld.md');
    expect(missing.ok && missing.notes.join(' ')).toContain('CMP-009 is not in model.yaml yet');
  });

  it('checks contracts against neighbours, and G3 waits until they agree', async () => {
    const store = await baseline();
    await store.write(
      'lld/CMP-002/lld.md',
      md(
        'LLD-CMP-002',
        'Called by CMP-001; stores in CMP-003.\n| CMP-004 | event OrderShipped |',
        'component: CMP-002\n',
      ),
    );
    await store.write(
      'lld/CMP-001/lld.md',
      md(
        'LLD-CMP-001',
        '| CMP-002 | POST /orders |\n| CMP-002 | DELETE /orders/{id} |',
        'component: CMP-001\n',
      ),
    );

    let check = await checkLld(store, 'CMP-002');
    expect(check.problems).toEqual([
      'CMP-002 is called synchronously (model.yaml relations) but has no lld/CMP-002/openapi.yaml',
      'CMP-002 sends or receives events but has no lld/CMP-002/asyncapi.yaml',
    ]);
    const g3 = await approveGate(store, 'G3:CMP-002', 'A', swaResources());
    expect(g3.ok).toBe(false);
    expect(g3.message).toContain('no lld/CMP-002/openapi.yaml');

    await store.write('lld/CMP-002/openapi.yaml', OPENAPI);
    await store.write('lld/CMP-002/asyncapi.yaml', ASYNCAPI);
    check = await checkLld(store, 'CMP-002');
    expect(check.problems).toEqual([]);
    expect(check.notes).toContain('CMP-004 has no LLD yet: event OrderShipped is unchecked');

    // The caller uses an operation its neighbour does not publish.
    expect((await checkLld(store, 'CMP-001')).problems).toEqual([
      'DELETE /orders/{} is not in lld/CMP-002/openapi.yaml'.replace('{}', '{id}'),
    ]);
    expect((await approveGate(store, 'G3:CMP-002', 'A', swaResources())).ok).toBe(true);
  });
});
