// TS/JS import graph from source text: static imports/exports, require() and import(). Relative
// specifiers are resolved against the file list (extensions and index files); bare specifiers are
// recorded as external packages. Regex-based on purpose: fast, no compiler, good enough for a map.

const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const IMPORT_RE =
  /(?:^|[^.\w$])(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+\s+from\s+)?["']([^"'\n]+)["']|(?:^|[^.\w$])(?:require|import)\s*\(\s*["']([^"'\n]+)["']\s*\)/g;
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

export function isSourceFile(path: string): boolean {
  return SOURCE.test(path) && !path.endsWith('.d.ts');
}

export function extractSpecifiers(text: string): string[] {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/.*$/gm, '$1');
  const out = new Set<string>();
  for (const m of noComments.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) out.add(spec);
  }
  return [...out];
}

function joinPosix(dir: string, rel: string): string {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** Resolve a relative specifier from `from` (folder-relative, `/`-separated) against `files`. */
export function resolveRelative(
  from: string,
  spec: string,
  files: ReadonlySet<string>,
): string | undefined {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const base = joinPosix(dir, spec);
  // `./x.js` in TS source usually means `./x.ts`.
  const stripped = base.replace(/\.(m|c)?js$/, '');
  for (const candidate of [base, stripped]) {
    for (const ext of EXTENSIONS) if (files.has(candidate + ext)) return candidate + ext;
    for (const ext of EXTENSIONS.slice(1))
      if (files.has(`${candidate}/index${ext}`)) return `${candidate}/index${ext}`;
  }
  return undefined;
}

export function packageOf(spec: string): string {
  if (spec.startsWith('node:')) return spec;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec);
}

export interface ImportGraph {
  edges: Map<string, Set<string>>;
  external: Map<string, Set<string>>;
  unresolved: Map<string, string[]>;
}

export function buildImportGraph(
  sources: ReadonlyMap<string, string>,
  allFiles: ReadonlySet<string>,
): ImportGraph {
  const edges = new Map<string, Set<string>>();
  const external = new Map<string, Set<string>>();
  const unresolved = new Map<string, string[]>();
  for (const [file, text] of sources) {
    const out = new Set<string>();
    for (const spec of extractSpecifiers(text)) {
      if (spec.startsWith('.') || spec.startsWith('/')) {
        const target = resolveRelative(file, spec, allFiles);
        if (target) out.add(target);
        else unresolved.set(file, [...(unresolved.get(file) ?? []), spec]);
      } else {
        const pkg = packageOf(spec);
        const users = external.get(pkg) ?? new Set<string>();
        users.add(file);
        external.set(pkg, users);
      }
    }
    edges.set(file, out);
  }
  return { edges, external, unresolved };
}

/** Import cycles (each reported once, as the file path loop), up to `limit`. */
export function findCycles(edges: ReadonlyMap<string, Set<string>>, limit = 10): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (node: string) => {
    if (cycles.length >= limit) return;
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const s = state.get(next);
      if (s === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const key = [...cycle].sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cycle, next]);
        }
      } else if (s === undefined) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys()) if (!state.has(node)) visit(node);
  return cycles;
}

export function formatGraph(graph: ImportGraph, focus?: string, limit = 60): string {
  const lines: string[] = [];
  if (focus) {
    const out = [...(graph.edges.get(focus) ?? [])];
    const inbound = [...graph.edges].filter(([, t]) => t.has(focus)).map(([f]) => f);
    const ext = [...graph.external].filter(([, users]) => users.has(focus)).map(([p]) => p);
    lines.push(
      `${focus}`,
      `  imports: ${out.join(', ') || '(none)'}`,
      `  imported by: ${inbound.join(', ') || '(none)'}`,
      `  packages: ${ext.join(', ') || '(none)'}`,
    );
    return lines.join('\n');
  }
  const fanIn = new Map<string, number>();
  for (const targets of graph.edges.values())
    for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
  const hubs = [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const packages = [...graph.external].sort((a, b) => b[1].size - a[1].size).slice(0, 25);
  lines.push(
    `${graph.edges.size} source files, ${[...graph.edges.values()].reduce((n, s) => n + s.size, 0)} internal imports.`,
  );
  lines.push(
    '',
    'Most imported files:',
    ...hubs.map(([f, n]) => `  ${n.toString().padStart(3)}  ${f}`),
  );
  lines.push(
    '',
    'External packages (files using them):',
    ...packages.map(([p, u]) => `  ${u.size.toString().padStart(3)}  ${p}`),
  );
  const cycles = findCycles(graph.edges);
  if (cycles.length) lines.push('', 'Import cycles:', ...cycles.map((c) => `  ${c.join(' -> ')}`));
  return lines.slice(0, limit + 10).join('\n');
}
