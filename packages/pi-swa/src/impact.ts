import { classifyPath, type GateId, gateOfPath } from './layout.js';
import { inputHash, readFrontmatter, setFrontmatterFields } from './markdown.js';
import type { ArchStore } from './store.js';
import { frontmatterInputs } from './validate.js';

// Change impact (phase 6), the part a tool can do: every Markdown artifact records the hashes of the
// inputs it was built from (writes.ts). An input whose hash no longer matches has changed; every
// artifact built from it, and from those, transitively, is affected. Marking them `stale` changes
// their text, so their gates reopen; the earliest one is where the architect re-enters.

export interface ImpactReport {
  /** Inputs that changed since an artifact was built from them. */
  changed: { input: string; usedBy: string[] }[];
  /** Every affected artifact (directly or through another one). */
  affected: string[];
  earliestGate?: string;
}

const GATE_ORDER: GateId[] = ['G0', 'G1', 'G2', 'G3'];

export async function impact(store: ArchStore): Promise<ImpactReport> {
  const paths = (await store.list()).filter(
    (p) => classifyPath(p).kind === 'artifact' && p.endsWith('.md'),
  );
  const deps = new Map<string, { path: string; hash?: string }[]>();
  const status = new Map<string, string>();
  const gateField = new Map<string, string>();
  for (const path of paths) {
    const fm = readFrontmatter((await store.read(path)) ?? '').data;
    deps.set(
      path,
      frontmatterInputs(fm).map((i) => ({ ...i, path: i.path.replace(/^arch\//, '') })),
    );
    if (typeof fm['status'] === 'string') status.set(path, fm['status']);
    if (typeof fm['gate'] === 'string') gateField.set(path, fm['gate']);
  }

  const current = new Map<string, string | null>();
  const hashOf = async (path: string) => {
    if (!current.has(path)) {
      const text = await store.read(path).catch(() => null);
      current.set(path, text === null ? null : inputHash(text));
    }
    return current.get(path) ?? null;
  };

  const changed = new Map<string, Set<string>>();
  const affected = new Set<string>();
  for (const [path, inputs] of deps) {
    if (status.get(path) === 'superseded') continue;
    for (const input of inputs) {
      if (!input.hash) continue;
      const now = await hashOf(input.path);
      if (now === input.hash) continue;
      if (!changed.has(input.path)) changed.set(input.path, new Set());
      changed.get(input.path)?.add(path);
      affected.add(path);
    }
  }
  // Transitively: whatever was built from an affected artifact is affected too.
  for (let grew = true; grew;) {
    grew = false;
    for (const [path, inputs] of deps) {
      if (affected.has(path) || status.get(path) === 'superseded') continue;
      if (inputs.some((i) => affected.has(i.path))) {
        affected.add(path);
        grew = true;
      }
    }
  }

  const gates = [...affected].map((p) => gateOfPath(p, gateField.get(p))).filter((g) => g !== null);
  const first = GATE_ORDER.find((g) => gates.some((x) => x.gate === g));
  const component = first === 'G3' ? gates.find((g) => g.gate === 'G3')?.component : undefined;
  return {
    changed: [...changed].map(([input, users]) => ({ input, usedBy: [...users].sort() })),
    affected: [...affected].sort(),
    ...(first && { earliestGate: component ? `G3:${component}` : first }),
  };
}

/** Marks the affected artifacts `stale` (not superseded or already stale ones). Returns the paths. */
export async function markStale(store: ArchStore, paths: readonly string[]): Promise<string[]> {
  const marked: string[] = [];
  for (const path of paths) {
    const text = await store.read(path);
    if (text === null) continue;
    const s = readFrontmatter(text).data['status'];
    if (s === 'stale' || s === 'superseded') continue;
    const next = setFrontmatterFields(text, { status: 'stale' });
    if (next === text) continue;
    await store.write(path, next);
    marked.push(path);
  }
  return marked;
}

export function renderImpact(r: ImpactReport, marked?: readonly string[]): string {
  if (!r.changed.length)
    return 'No impact: every artifact was built from the current version of its inputs.';
  const lines = ['Changed since the artifacts were built:'];
  for (const c of r.changed)
    lines.push(`- arch/${c.input} (used by ${c.usedBy.map((p) => `arch/${p}`).join(', ')})`);
  lines.push(`Affected: ${r.affected.map((p) => `arch/${p}`).join(', ')}.`);
  if (r.earliestGate) lines.push(`Earliest affected gate: ${r.earliestGate}. Re-run from there.`);
  if (marked) {
    lines.push(
      marked.length
        ? `Marked stale: ${marked.map((p) => `arch/${p}`).join(', ')}.`
        : 'Nothing new to mark stale.',
    );
  }
  return lines.join('\n');
}
