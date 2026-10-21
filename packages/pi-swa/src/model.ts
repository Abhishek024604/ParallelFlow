import { parse } from 'yaml';
import { CMP_ID } from './layout.js';
import type { ArchStore } from './store.js';

// arch/model.yaml: the component model, the single source the HLD diagrams are generated from
// (docs/15 "Diagrams are generated from model.yaml"). Components carry the traceability links:
// satisfies (FR/NFR/CON) → adrs → code paths.

export type ComponentKind =
  'service' | 'ui' | 'database' | 'queue' | 'storage' | 'function' | 'gateway' | 'cache' | 'other';

export const COMPONENT_KINDS: readonly ComponentKind[] = [
  'service',
  'ui',
  'database',
  'queue',
  'storage',
  'function',
  'gateway',
  'cache',
  'other',
];

export interface ModelNode {
  id: string;
  name: string;
  description?: string;
}

export interface Component extends ModelNode {
  kind: ComponentKind;
  tech?: string;
  satisfies: string[];
  adrs: string[];
  code: string[];
}

export interface Relation {
  from: string;
  to: string;
  label?: string;
  kind?: 'sync' | 'async';
}

export interface Flow {
  id: string;
  name: string;
  steps: Relation[];
}

export interface DeploymentNode extends ModelNode {
  kind?: string;
  contains: string[];
}

export interface ArchModel {
  system: { name: string; description?: string };
  actors: ModelNode[];
  externals: ModelNode[];
  components: Component[];
  relations: Relation[];
  flows: Flow[];
  deployment: DeploymentNode[];
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : [];
const objs = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    : [];

function node(o: Record<string, unknown>): ModelNode | null {
  const id = str(o['id']);
  if (!id) return null;
  const description = str(o['description']);
  return { id, name: str(o['name']) ?? id, ...(description && { description }) };
}

function relation(o: Record<string, unknown>): Relation | null {
  const from = str(o['from']);
  const to = str(o['to']);
  if (!from || !to) return null;
  const label = str(o['label']);
  const kind = o['kind'] === 'async' ? 'async' : o['kind'] === 'sync' ? 'sync' : undefined;
  return { from, to, ...(label && { label }), ...(kind && { kind }) };
}

/** Parses model.yaml leniently; `problems` lists what checkModel would reject. */
export function parseModel(text: string): { model: ArchModel; problems: string[] } {
  const problems: string[] = [];
  let doc: Record<string, unknown> = {};
  try {
    const parsed: unknown = parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      doc = parsed as Record<string, unknown>;
    } else problems.push('model.yaml is not a YAML mapping');
  } catch (err) {
    problems.push(`model.yaml is not valid YAML (${(err as Error).message.split('\n')[0]})`);
  }
  const system = (doc['system'] ?? {}) as Record<string, unknown>;
  const components = objs(doc['components']).flatMap((o) => {
    const n = node(o);
    if (!n) return [];
    const kind = COMPONENT_KINDS.includes(o['kind'] as ComponentKind)
      ? (o['kind'] as ComponentKind)
      : 'other';
    const tech = str(o['tech']);
    return [
      {
        ...n,
        kind,
        ...(tech && { tech }),
        satisfies: strs(o['satisfies']),
        adrs: strs(o['adrs']),
        code: strs(o['code']),
      },
    ];
  });
  const model: ArchModel = {
    system: {
      name: str(system['name']) ?? 'System',
      ...(str(system['description']) && { description: str(system['description']) as string }),
    },
    actors: objs(doc['actors']).flatMap((o) => node(o) ?? []),
    externals: objs(doc['externals']).flatMap((o) => node(o) ?? []),
    components,
    relations: objs(doc['relations']).flatMap((o) => relation(o) ?? []),
    flows: objs(doc['flows']).flatMap((o) => {
      const id = str(o['id']);
      if (!id) return [];
      return [
        {
          id,
          name: str(o['name']) ?? id,
          steps: objs(o['steps']).flatMap((s) => relation(s) ?? []),
        },
      ];
    }),
    deployment: objs(doc['deployment']).flatMap((o) => {
      const n = node(o);
      if (!n) return [];
      const kind = str(o['kind']);
      return [{ ...n, ...(kind && { kind }), contains: strs(o['contains']) }];
    }),
  };
  problems.push(...checkModel(model));
  return { model, problems };
}

/** Structural checks: ids, references, every component placed and justified. */
export function checkModel(model: ArchModel): string[] {
  const out: string[] = [];
  const ids = new Map<string, number>();
  const all = [...model.actors, ...model.externals, ...model.components];
  for (const n of all) ids.set(n.id, (ids.get(n.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.push(`id ${id} is used ${n} times`);
  if (!model.components.length) out.push('there are no components');
  for (const c of model.components) {
    if (!CMP_ID.test(c.id)) out.push(`component id "${c.id}" must look like CMP-001`);
    if (!c.satisfies.length) {
      out.push(`${c.id} satisfies no requirement (add FR/NFR/CON ids to \`satisfies\`)`);
    }
  }
  const known = (id: string) => ids.has(id);
  for (const r of model.relations) {
    for (const end of [r.from, r.to])
      if (!known(end)) out.push(`relation ${r.from} → ${r.to}: unknown id ${end}`);
  }
  for (const f of model.flows) {
    if (!f.steps.length) out.push(`flow ${f.id} has no steps`);
    for (const s of f.steps) {
      for (const end of [s.from, s.to])
        if (!known(end)) out.push(`flow ${f.id}: unknown id ${end}`);
    }
  }
  for (const d of model.deployment) {
    for (const id of d.contains) {
      if (!model.components.some((c) => c.id === id))
        out.push(`deployment ${d.id}: unknown component ${id}`);
    }
  }
  return out;
}

export async function readModel(
  store: ArchStore,
): Promise<{ model: ArchModel; problems: string[] } | null> {
  const text = await store.read('model.yaml');
  return text === null ? null : parseModel(text);
}
