// Dependency analysis from manifests and lockfiles: npm/pnpm/yarn, pip/pyproject, go.mod, Cargo.
// Small line-based parsers (no YAML/TOML libraries): enough to list direct dependencies with the
// declared range and, where a lockfile pins it, the resolved version.

export interface Dependency {
  name: string;
  /** Declared range or requirement. */
  spec: string;
  /** Version pinned by the lockfile, when one was found. */
  locked?: string;
  kind: 'prod' | 'dev' | 'optional' | 'peer' | 'build';
}

export interface ManifestReport {
  ecosystem: 'npm' | 'python' | 'go' | 'cargo';
  manifest: string;
  lockfile?: string;
  name?: string;
  dependencies: Dependency[];
}

type Files = Record<string, string | undefined>;

export function parsePackageJson(text: string): {
  name?: string;
  deps: Dependency[];
  workspaces: string[];
} {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { deps: [], workspaces: [] };
  }
  const deps: Dependency[] = [];
  const sections: [string, Dependency['kind']][] = [
    ['dependencies', 'prod'],
    ['devDependencies', 'dev'],
    ['optionalDependencies', 'optional'],
    ['peerDependencies', 'peer'],
  ];
  for (const [key, kind] of sections) {
    const section = pkg[key];
    if (section && typeof section === 'object') {
      for (const [name, spec] of Object.entries(section as Record<string, unknown>)) {
        deps.push({ name, spec: String(spec), kind });
      }
    }
  }
  const ws = pkg.workspaces;
  const workspaces = Array.isArray(ws)
    ? ws.map(String)
    : ws && typeof ws === 'object' && Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages.map(String)
      : [];
  return { name: typeof pkg.name === 'string' ? pkg.name : undefined, deps, workspaces };
}

/** package-lock.json v2/v3: packages["node_modules/<name>"].version. */
export function lockedFromPackageLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const lock = JSON.parse(text) as { packages?: Record<string, { version?: string }> };
    for (const [key, value] of Object.entries(lock.packages ?? {})) {
      const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && value.version && !out.has(m[1] ?? '')) out.set(m[1] ?? '', value.version);
    }
  } catch {
    // ignore a malformed lockfile
  }
  return out;
}

/** pnpm-lock.yaml (v6–v9): the root importer's `<name>:\n  specifier: x\n  version: y` entries. */
export function lockedFromPnpmLock(text: string, importer = '.'): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.split(/\r?\n/);
  let inImporter = false;
  let current: string | undefined;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) continue;
    const imp = /^ {2}(\S.*):\s*$/.exec(line);
    if (imp) {
      inImporter = (imp[1] ?? '').replace(/^['"]|['"]$/g, '') === importer;
      continue;
    }
    if (/^\S/.test(line)) {
      inImporter = false;
      continue;
    }
    if (!inImporter) continue;
    const dep = /^ {6}(\S.*?):\s*$/.exec(line);
    if (dep) {
      current = (dep[1] ?? '').replace(/^['"]|['"]$/g, '');
      continue;
    }
    const ver = /^ {8}version:\s*(.+)$/.exec(line);
    if (ver && current)
      out.set(
        current,
        (ver[1] ?? '')
          .trim()
          .replace(/^['"]|['"]$/g, '')
          .replace(/\(.*$/, ''),
      );
  }
  return out;
}

/** yarn.lock v1 and berry: `"name@range":` headers followed by `version "x"` / `version: x`. */
export function lockedFromYarnLock(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line) && line.trimEnd().endsWith(':')) {
      names = line
        .slice(0, -1)
        .split(',')
        .map((s) => s.trim().replace(/^"|"$/g, ''))
        .map((s) => s.replace(/@(npm:)?[^@]*$/, ''))
        .filter(Boolean);
      continue;
    }
    const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(line);
    if (v) for (const n of names) if (!out.has(n)) out.set(n, v[1] ?? '');
  }
  return out;
}

export function parseRequirements(text: string): Dependency[] {
  const deps: Dependency[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || line.startsWith('-')) continue;
    const m = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(line);
    if (m) deps.push({ name: m[1] ?? '', spec: (m[3] ?? '').trim() || '*', kind: 'prod' });
  }
  return deps;
}

/** pyproject.toml: PEP 621 `dependencies = [...]` and Poetry `[tool.poetry.dependencies]`. */
export function parsePyproject(text: string): { name?: string; deps: Dependency[] } {
  const deps: Dependency[] = [];
  let name: string | undefined;
  let table = '';
  let inArray: Dependency['kind'] | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) {
      table = (t[1] ?? '').trim();
      inArray = undefined;
      continue;
    }
    if (inArray) {
      for (const s of line.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const req = s[1] ?? s[2] ?? '';
        const m = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(req);
        if (m) deps.push({ name: m[1] ?? '', spec: (m[3] ?? '').trim() || '*', kind: inArray });
      }
      if (line.includes(']')) inArray = undefined;
      continue;
    }
    if (table === 'project' && /^name\s*=/.test(line)) name = /=\s*["']([^"']+)/.exec(line)?.[1];
    if (table === 'project' && /^dependencies\s*=\s*\[/.test(line)) {
      inArray = 'prod';
      const rest = line.slice(line.indexOf('[') + 1);
      for (const s of rest.matchAll(/"([^"]+)"|'([^']+)'/g)) {
        const m = /^([A-Za-z0-9._-]+)(\[[^\]]*\])?\s*(.*)$/.exec(s[1] ?? s[2] ?? '');
        if (m) deps.push({ name: m[1] ?? '', spec: (m[3] ?? '').trim() || '*', kind: 'prod' });
      }
      if (rest.includes(']')) inArray = undefined;
      continue;
    }
    const poetry =
      /^tool\.poetry\.(dev-)?dependencies$|^tool\.poetry\.group\.[^.]+\.dependencies$/.exec(table);
    if (poetry) {
      const kv = /^([A-Za-z0-9._-]+)\s*=\s*(.+)$/.exec(line);
      if (kv && kv[1] !== 'python') {
        const spec = (kv[2] ?? '').replace(/^["']|["']$/g, '');
        deps.push({
          name: kv[1] ?? '',
          spec,
          kind:
            table.includes('dependencies') && table !== 'tool.poetry.dependencies' ? 'dev' : 'prod',
        });
      }
    }
  }
  return { name, deps };
}

/** poetry.lock / Cargo.lock / uv.lock: `[[package]]` with name and version keys. */
export function lockedFromTomlPackages(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let name: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '[[package]]') {
      name = undefined;
      continue;
    }
    const n = /^name\s*=\s*"([^"]+)"/.exec(line);
    if (n) name = n[1];
    const v = /^version\s*=\s*"([^"]+)"/.exec(line);
    if (v && name && !out.has(name)) out.set(name, v[1] ?? '');
  }
  return out;
}

export function parseGoMod(text: string): { name?: string; deps: Dependency[] } {
  const deps: Dependency[] = [];
  let name: string | undefined;
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const mod = /^module\s+(\S+)/.exec(line);
    if (mod) name = mod[1];
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const single = /^require\s+(\S+)\s+(\S+)/.exec(line);
    const entry = inBlock ? /^(\S+)\s+(\S+)/.exec(line) : single;
    if (entry)
      deps.push({
        name: entry[1] ?? '',
        spec: entry[2] ?? '',
        locked: entry[2] ?? '',
        kind: 'prod',
      });
  }
  return { name, deps };
}

export function parseCargoToml(text: string): { name?: string; deps: Dependency[] } {
  const deps: Dependency[] = [];
  let name: string | undefined;
  let table = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) {
      table = (t[1] ?? '').trim();
      continue;
    }
    if (table === 'package' && /^name\s*=/.test(line)) name = /=\s*"([^"]+)"/.exec(line)?.[1];
    const kind: Dependency['kind'] | undefined =
      table === 'dependencies'
        ? 'prod'
        : table === 'dev-dependencies'
          ? 'dev'
          : table === 'build-dependencies'
            ? 'build'
            : undefined;
    if (!kind) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const value = kv[2] ?? '';
    const spec = value.startsWith('"')
      ? value.replace(/"/g, '')
      : (/version\s*=\s*"([^"]+)"/.exec(value)?.[1] ?? value);
    deps.push({ name: kv[1] ?? '', spec, kind });
  }
  return { name, deps };
}

function withLocks(deps: Dependency[], locks: Map<string, string> | undefined): Dependency[] {
  if (!locks) return deps;
  return deps.map((d) => (locks.has(d.name) ? { ...d, locked: locks.get(d.name) } : d));
}

/**
 * Analyse one directory. `files` maps file names in that directory to their contents (undefined
 * when absent); `pnpmImporter` is the directory's path relative to the pnpm workspace root.
 */
export function analyzeDirectory(files: Files, dir = '.', pnpmLock?: string): ManifestReport[] {
  const reports: ManifestReport[] = [];
  const pj = files['package.json'];
  if (pj !== undefined) {
    const parsed = parsePackageJson(pj);
    let locks: Map<string, string> | undefined;
    let lockfile: string | undefined;
    const pnpm = files['pnpm-lock.yaml'] ?? pnpmLock;
    if (files['package-lock.json'] !== undefined) {
      locks = lockedFromPackageLock(files['package-lock.json']);
      lockfile = 'package-lock.json';
    } else if (pnpm !== undefined) {
      locks = lockedFromPnpmLock(pnpm, dir);
      lockfile = 'pnpm-lock.yaml';
    } else if (files['yarn.lock'] !== undefined) {
      locks = lockedFromYarnLock(files['yarn.lock']);
      lockfile = 'yarn.lock';
    }
    reports.push({
      ecosystem: 'npm',
      manifest: 'package.json',
      lockfile,
      name: parsed.name,
      dependencies: withLocks(parsed.deps, locks),
    });
  }
  const pyLock = files['poetry.lock'] ?? files['uv.lock'];
  const pyLocks = pyLock !== undefined ? lockedFromTomlPackages(pyLock) : undefined;
  const pyLockName =
    files['poetry.lock'] !== undefined
      ? 'poetry.lock'
      : files['uv.lock'] !== undefined
        ? 'uv.lock'
        : undefined;
  if (files['pyproject.toml'] !== undefined) {
    const parsed = parsePyproject(files['pyproject.toml']);
    reports.push({
      ecosystem: 'python',
      manifest: 'pyproject.toml',
      lockfile: pyLockName,
      name: parsed.name,
      dependencies: withLocks(parsed.deps, pyLocks),
    });
  }
  if (files['requirements.txt'] !== undefined) {
    reports.push({
      ecosystem: 'python',
      manifest: 'requirements.txt',
      dependencies: withLocks(parseRequirements(files['requirements.txt']), pyLocks),
    });
  }
  if (files['go.mod'] !== undefined) {
    const parsed = parseGoMod(files['go.mod']);
    reports.push({
      ecosystem: 'go',
      manifest: 'go.mod',
      lockfile: files['go.sum'] !== undefined ? 'go.sum' : undefined,
      name: parsed.name,
      dependencies: parsed.deps,
    });
  }
  if (files['Cargo.toml'] !== undefined) {
    const parsed = parseCargoToml(files['Cargo.toml']);
    const locks =
      files['Cargo.lock'] !== undefined ? lockedFromTomlPackages(files['Cargo.lock']) : undefined;
    reports.push({
      ecosystem: 'cargo',
      manifest: 'Cargo.toml',
      lockfile: locks ? 'Cargo.lock' : undefined,
      name: parsed.name,
      dependencies: withLocks(parsed.deps, locks),
    });
  }
  return reports;
}

export const MANIFEST_FILES = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'pyproject.toml',
  'requirements.txt',
  'poetry.lock',
  'uv.lock',
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
];

export function formatReports(dir: string, reports: ManifestReport[]): string {
  if (reports.length === 0) return `${dir}: no package manifest found`;
  return reports
    .map((r) => {
      const head = `${dir === '.' ? '' : `${dir}/`}${r.manifest}${r.name ? ` (${r.name})` : ''} [${r.ecosystem}${r.lockfile ? `, locked by ${r.lockfile}` : ', no lockfile'}]`;
      const lines = r.dependencies.map(
        (d) =>
          `  ${d.kind.padEnd(8)} ${d.name} ${d.spec}${d.locked && d.locked !== d.spec ? ` -> ${d.locked}` : ''}`,
      );
      return [head, ...(lines.length ? lines : ['  (no dependencies)'])].join('\n');
    })
    .join('\n\n');
}
