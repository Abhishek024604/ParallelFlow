// A generated architecture summary (modules, entry points, layers, internal dependencies, import
// hubs), cached in .saras/architecture.md so the agent can read it at the start of every task.
import { buildImportGraph, isSourceFile } from './imports.js';
import { parsePackageJson } from './deps.js';

export interface ArchitectureInput {
  files: readonly string[];
  readFile(rel: string): Promise<string | undefined>;
  now?: Date;
  /** Cap on source files read for the import graph. */
  maxSources?: number;
}

const MANIFESTS = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml'];
const ENTRY_HINTS = [
  /^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|mjs|cjs|py|go|rs)$/,
  /(^|\/)app\/(page|layout)\.(tsx|jsx)$/,
  /(^|\/)cmd\/[^/]+\/main\.go$/,
  /(^|\/)src\/(main|lib)\.rs$/,
  /(^|\/)__main__\.py$/,
  /(^|\/)manage\.py$/,
];
const LAYER_NAMES: Record<string, string> = {
  apps: 'applications',
  packages: 'shared packages',
  libs: 'libraries',
  services: 'services',
  api: 'API',
  web: 'web front end',
  ui: 'UI components',
  components: 'UI components',
  db: 'database',
  migrations: 'database migrations',
  infra: 'infrastructure',
  scripts: 'scripts',
  docs: 'documentation',
  test: 'tests',
  tests: 'tests',
  e2e: 'end-to-end tests',
};

interface Module {
  dir: string;
  manifest: string;
  name?: string;
  description?: string;
  entries: string[];
  scripts: string[];
  internalDeps: string[];
  fileCount: number;
}

function dirOf(file: string): string {
  return file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
}

export async function generateArchitecture(input: ArchitectureInput): Promise<string> {
  const { files } = input;
  const modules: Module[] = [];
  for (const f of files) {
    const base = f.split('/').pop() ?? f;
    if (!MANIFESTS.includes(base) || f.split('/').length > 4) continue;
    const dir = dirOf(f);
    if (modules.some((m) => m.dir === dir)) continue;
    const prefix = dir === '.' ? '' : `${dir}/`;
    const mod: Module = {
      dir,
      manifest: base,
      entries: [],
      scripts: [],
      internalDeps: [],
      fileCount: files.filter((x) => x.startsWith(prefix)).length,
    };
    if (base === 'package.json') {
      const text = await input.readFile(f);
      if (text) {
        try {
          const pkg = JSON.parse(text) as Record<string, unknown>;
          if (typeof pkg.description === 'string') mod.description = pkg.description;
          for (const key of ['main', 'module', 'types']) {
            if (typeof pkg[key] === 'string') mod.entries.push(`${key}: ${String(pkg[key])}`);
          }
          if (typeof pkg.bin === 'string') mod.entries.push(`bin: ${pkg.bin}`);
          else if (pkg.bin && typeof pkg.bin === 'object') {
            mod.entries.push(...Object.entries(pkg.bin).map(([k, v]) => `bin ${k}: ${String(v)}`));
          }
          const exp = pkg.exports;
          if (typeof exp === 'string') mod.entries.push(`exports: ${exp}`);
          else if (exp && typeof exp === 'object')
            mod.entries.push(`exports: ${Object.keys(exp).slice(0, 6).join(', ')}`);
          if (pkg.scripts && typeof pkg.scripts === 'object')
            mod.scripts = Object.keys(pkg.scripts);
        } catch {
          // ignore malformed manifest
        }
        const parsed = parsePackageJson(text);
        mod.name = parsed.name;
        mod.internalDeps = parsed.deps.map((d) => d.name);
      }
    }
    for (const g of files) {
      if (!g.startsWith(prefix)) continue;
      const rel = g.slice(prefix.length);
      if (ENTRY_HINTS.some((re) => re.test(rel)) && mod.entries.length < 12) mod.entries.push(rel);
    }
    modules.push(mod);
  }
  const names = new Set(modules.map((m) => m.name).filter((n): n is string => Boolean(n)));
  for (const m of modules) m.internalDeps = m.internalDeps.filter((d) => names.has(d));

  // Top-level layout.
  const top = new Map<string, { count: number; exts: Map<string, number> }>();
  for (const f of files) {
    const head = f.includes('/') ? `${f.split('/')[0]}/` : '(root files)';
    const entry = top.get(head) ?? { count: 0, exts: new Map() };
    entry.count += 1;
    const ext = /\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase() ?? '';
    if (ext) entry.exts.set(ext, (entry.exts.get(ext) ?? 0) + 1);
    top.set(head, entry);
  }

  // Layers from folder names anywhere in the first two levels.
  const layers = new Map<string, Set<string>>();
  for (const f of files) {
    const parts = f.split('/').slice(0, 2);
    parts.pop();
    for (const p of parts) {
      const label = LAYER_NAMES[p.toLowerCase()];
      if (label) layers.set(label, (layers.get(label) ?? new Set()).add(p));
    }
  }

  // Import hubs (TS/JS).
  const sources = files.filter(isSourceFile).slice(0, input.maxSources ?? 1500);
  const texts = new Map<string, string>();
  for (const f of sources) {
    const t = await input.readFile(f);
    if (t !== undefined && t.length < 512 * 1024) texts.set(f, t);
  }
  const graph = buildImportGraph(texts, new Set(files));
  const fanIn = new Map<string, number>();
  for (const targets of graph.edges.values())
    for (const t of targets) fanIn.set(t, (fanIn.get(t) ?? 0) + 1);
  const hubs = [...fanIn].sort((a, b) => b[1] - a[1]).slice(0, 12);

  const md: string[] = [
    '# Architecture summary',
    '',
    `Generated by Saras on ${(input.now ?? new Date()).toISOString()} from ${files.length} files. Refresh it with "Saras: Refresh architecture summary" or the architecture tool.`,
    '',
    '## Layout',
    '',
    ...[...top]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 25)
      .map(([dir, v]) => {
        const exts = [...v.exts]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([e]) => e)
          .join(', ');
        return `- \`${dir}\` ${v.count} files${exts ? ` (${exts})` : ''}`;
      }),
    '',
  ];
  if (layers.size) {
    md.push(
      '## Layers',
      '',
      ...[...layers].map(
        ([label, dirs]) => `- ${label}: ${[...dirs].map((d) => `\`${d}/\``).join(', ')}`,
      ),
      '',
    );
  }
  if (modules.length) {
    md.push('## Modules', '');
    for (const m of modules.sort((a, b) => a.dir.localeCompare(b.dir))) {
      md.push(`### \`${m.dir}\`${m.name ? ` — ${m.name}` : ''}`, '');
      if (m.description) md.push(m.description, '');
      md.push(`- ${m.manifest}, ${m.fileCount} files`);
      if (m.entries.length) md.push(`- entry points: ${m.entries.join('; ')}`);
      if (m.scripts.length) md.push(`- scripts: ${m.scripts.slice(0, 15).join(', ')}`);
      if (m.internalDeps.length) md.push(`- depends on: ${m.internalDeps.join(', ')}`);
      md.push('');
    }
  }
  if (hubs.length) {
    md.push(
      '## Most imported files',
      '',
      ...hubs.map(([f, n]) => `- \`${f}\` (${n} importers)`),
      '',
    );
  }
  return md.join('\n');
}
