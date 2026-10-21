import { parse } from 'yaml';
import { readModel } from './model.js';
import type { ArchStore } from './store.js';

// The LLD consistency check (docs/15 "consistency check between neighbouring LLDs"): a component's
// LLD must publish the contract its neighbours rely on, and every operation or event it uses from a
// neighbour must exist in that neighbour's contract. Neighbours come from model.yaml relations.

export interface LldCheck {
  component: string;
  problems: string[];
  notes: string[];
}

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];

/** "GET /orders/{id}" for each operation in an OpenAPI document. */
export function openapiOperations(text: string): Set<string> {
  const out = new Set<string>();
  try {
    const doc = parse(text) as { paths?: Record<string, Record<string, unknown>> };
    for (const [path, item] of Object.entries(doc?.paths ?? {})) {
      for (const method of Object.keys(item ?? {})) {
        if (METHODS.includes(method.toLowerCase())) out.add(`${method.toUpperCase()} ${path}`);
      }
    }
  } catch {
    // Reported by swa_validate.
  }
  return out;
}

/** Channel and message names in an AsyncAPI document (2.x or 3.x). */
export function asyncapiEvents(text: string): Set<string> {
  const out = new Set<string>();
  try {
    const doc = parse(text) as {
      channels?: Record<
        string,
        { messages?: Record<string, { name?: string }>; publish?: unknown; subscribe?: unknown }
      >;
      components?: { messages?: Record<string, { name?: string }> };
    };
    for (const [name, channel] of Object.entries(doc?.channels ?? {})) {
      out.add(name);
      for (const [key, m] of Object.entries(channel?.messages ?? {})) out.add(m?.name ?? key);
    }
    for (const [key, m] of Object.entries(doc?.components?.messages ?? {})) out.add(m?.name ?? key);
  } catch {
    // Reported by swa_validate.
  }
  return out;
}

/** Normalizes path parameters so "/orders/{orderId}" and "/orders/{id}" match. */
const normOp = (op: string) => op.replace(/\{[^}]+\}/g, '{}');

/**
 * What an LLD says it uses from neighbours: lines that name a component id together with an HTTP
 * operation ("CMP-002 POST /orders") or an event ("CMP-004 event OrderPlaced").
 */
export function usedFromNeighbours(
  lldMd: string,
): { component: string; op?: string; event?: string }[] {
  const out: { component: string; op?: string; event?: string }[] = [];
  for (const line of lldMd.split(/\r?\n/)) {
    const comps = line.match(/\bCMP-\d{1,4}\b/g);
    if (!comps) continue;
    for (const m of line.matchAll(
      /\b(GET|PUT|POST|DELETE|PATCH|HEAD|OPTIONS)\s+(\/[^\s|`,;)]*)/g,
    )) {
      for (const component of comps) out.push({ component, op: `${m[1]} ${m[2]}` });
    }
    for (const m of line.matchAll(/\bevent\s+`?([A-Za-z][\w.-]*)`?/gi)) {
      for (const component of comps) out.push({ component, event: m[1] as string });
    }
  }
  return out;
}

export async function checkLld(store: ArchStore, component: string): Promise<LldCheck> {
  const result: LldCheck = { component, problems: [], notes: [] };
  const parsed = await readModel(store);
  const model = parsed?.model;
  if (!model?.components.some((c) => c.id === component)) {
    result.problems.push(`${component} is not a component in model.yaml`);
    return result;
  }
  const dir = `lld/${component}`;
  const lld = await store.read(`${dir}/lld.md`);
  if (lld === null) {
    result.problems.push(`arch/${dir}/lld.md does not exist`);
    return result;
  }
  const files = (await store.list()).filter((p) => p.startsWith(`${dir}/`));
  const has = (name: string) => files.includes(`${dir}/${name}`);

  // What this component must publish.
  const servesSync = model.relations.some((r) => r.to === component && r.kind !== 'async');
  const eventsInvolved = model.relations.some(
    (r) => r.kind === 'async' && (r.from === component || r.to === component),
  );
  const kind = model.components.find((c) => c.id === component)?.kind;
  const isStore = kind === 'database' || kind === 'cache' || kind === 'storage' || kind === 'queue';
  if (servesSync && !isStore && !has('openapi.yaml')) {
    result.problems.push(
      `${component} is called synchronously (model.yaml relations) but has no ${dir}/openapi.yaml`,
    );
  }
  if (eventsInvolved && !isStore && !has('asyncapi.yaml')) {
    result.problems.push(`${component} sends or receives events but has no ${dir}/asyncapi.yaml`);
  }
  if (!files.some((f) => /sequence-[\w-]+\.drawio$/.test(f)))
    result.notes.push('no sequence diagram yet (sequence-*.drawio)');
  if (!has('component.drawio')) result.notes.push('no component diagram yet (component.drawio)');

  // Every neighbour it talks to is named, and what it uses exists in the neighbour's contract.
  const neighbours = new Set(
    model.relations
      .flatMap((r) => (r.from === component ? [r.to] : r.to === component ? [r.from] : []))
      .filter((id) => /^CMP-/.test(id)),
  );
  for (const n of neighbours)
    if (!lld.includes(n)) result.problems.push(`lld.md does not mention its neighbour ${n}`);

  const contracts = new Map<string, { ops: Set<string>; events: Set<string>; lld: boolean }>();
  const contractOf = async (id: string) => {
    let c = contracts.get(id);
    if (!c) {
      const openapi = await store.read(`lld/${id}/openapi.yaml`);
      const asyncapi = await store.read(`lld/${id}/asyncapi.yaml`);
      c = {
        ops: new Set([...(openapi ? openapiOperations(openapi) : [])].map(normOp)),
        events: asyncapi ? asyncapiEvents(asyncapi) : new Set(),
        lld: (await store.read(`lld/${id}/lld.md`)) !== null,
      };
      contracts.set(id, c);
    }
    return c;
  };
  for (const use of usedFromNeighbours(lld)) {
    if (use.component === component) continue;
    if (!neighbours.has(use.component)) {
      result.problems.push(
        `lld.md uses ${use.component}, which model.yaml does not connect to ${component}`,
      );
      continue;
    }
    const c = await contractOf(use.component);
    if (!c.lld) {
      result.notes.push(
        `${use.component} has no LLD yet: ${use.op ?? `event ${use.event}`} is unchecked`,
      );
      continue;
    }
    if (use.op && c.ops.size && !c.ops.has(normOp(use.op))) {
      result.problems.push(`${use.op} is not in lld/${use.component}/openapi.yaml`);
    }
    if (use.event && c.events.size && !c.events.has(use.event)) {
      result.problems.push(`event ${use.event} is not in lld/${use.component}/asyncapi.yaml`);
    }
  }
  return result;
}

export function renderLldCheck(r: LldCheck): string {
  const lines = [`LLD check for ${r.component}:`];
  if (!r.problems.length) lines.push('Consistent with its neighbours.');
  lines.push(...r.problems.map((p) => `PROBLEM: ${p}`), ...r.notes.map((n) => `Note: ${n}`));
  return lines.join('\n');
}
