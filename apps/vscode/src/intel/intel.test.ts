import { describe, expect, it } from 'vitest';
import { generateArchitecture } from './architecture.js';
import {
  analyzeDirectory,
  lockedFromPnpmLock,
  lockedFromYarnLock,
  parseCargoToml,
  parseGoMod,
  parsePyproject,
} from './deps.js';
import { renderTree } from './files.js';
import { buildImportGraph, extractSpecifiers, findCycles, resolveRelative } from './imports.js';
import { callTool, type IntelBackend } from './tools.js';

describe('dependencies', () => {
  it('npm with package-lock', () => {
    const [r] = analyzeDirectory({
      'package.json': JSON.stringify({
        name: 'app',
        dependencies: { zod: '^3.0.0' },
        devDependencies: { vitest: '^2' },
      }),
      'package-lock.json': JSON.stringify({
        packages: {
          '': {},
          'node_modules/zod': { version: '3.25.1' },
          'node_modules/vitest': { version: '2.1.9' },
        },
      }),
    });
    expect(r).toMatchObject({ ecosystem: 'npm', lockfile: 'package-lock.json', name: 'app' });
    expect(r!.dependencies).toEqual([
      { name: 'zod', spec: '^3.0.0', kind: 'prod', locked: '3.25.1' },
      { name: 'vitest', spec: '^2', kind: 'dev', locked: '2.1.9' },
    ]);
  });

  it('pnpm importers and yarn entries', () => {
    const pnpm = [
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      zod:',
      '        specifier: ^3',
      '        version: 3.25.76',
      '  apps/web:',
      '    dependencies:',
      "      '@types/node':",
      '        specifier: ^22',
      '        version: 22.20.5(foo@1)',
      'packages:',
    ].join('\n');
    expect(lockedFromPnpmLock(pnpm).get('zod')).toBe('3.25.76');
    expect(lockedFromPnpmLock(pnpm, 'apps/web').get('@types/node')).toBe('22.20.5');
    const yarn =
      '"@scope/a@^1.0.0", "@scope/a@^1.1.0":\n  version "1.2.3"\nleft-pad@^1:\n  version: 1.3.0\n';
    const y = lockedFromYarnLock(yarn);
    expect(y.get('@scope/a')).toBe('1.2.3');
    expect(y.get('left-pad')).toBe('1.3.0');
  });

  it('python, go and cargo', () => {
    const py = parsePyproject(
      '[project]\nname = "svc"\ndependencies = [\n  "fastapi>=0.110",\n  "uvicorn[standard]",\n]\n[tool.poetry.dev-dependencies]\npytest = "^8"\n',
    );
    expect(py.name).toBe('svc');
    expect(py.deps.map((d) => `${d.kind}:${d.name}:${d.spec}`)).toEqual([
      'prod:fastapi:>=0.110',
      'prod:uvicorn:*',
      'dev:pytest:^8',
    ]);
    const go = parseGoMod(
      'module example.com/x\n\nrequire (\n\tgithub.com/a/b v1.2.3\n\tgolang.org/x/y v0.1.0 // indirect\n)\nrequire c.io/d v2.0.0\n',
    );
    expect(go.deps.map((d) => d.name)).toEqual(['github.com/a/b', 'golang.org/x/y', 'c.io/d']);
    const cargo = parseCargoToml(
      '[package]\nname = "crab"\n[dependencies]\nserde = { version = "1.0", features = ["derive"] }\ntokio = "1"\n[dev-dependencies]\ninsta = "1.3"\n',
    );
    expect(cargo.deps).toEqual([
      { name: 'serde', spec: '1.0', kind: 'prod' },
      { name: 'tokio', spec: '1', kind: 'prod' },
      { name: 'insta', spec: '1.3', kind: 'dev' },
    ]);
  });
});

describe('import graph', () => {
  it('extracts specifiers but not commented ones', () => {
    const text =
      "import a from './a.js';\nimport type { B } from \"../b\";\nexport * from './c';\nconst d = require('lodash/fp');\nconst e = await import('@scope/pkg/x');\n// import z from './z';\n";
    expect(extractSpecifiers(text)).toEqual(['./a.js', '../b', './c', 'lodash/fp', '@scope/pkg/x']);
  });

  it('resolves .js to .ts and index files, finds cycles', () => {
    const files = new Set(['src/a.ts', 'src/b/index.ts', 'src/c.tsx']);
    expect(resolveRelative('src/c.tsx', './a.js', files)).toBe('src/a.ts');
    expect(resolveRelative('src/a.ts', './b', files)).toBe('src/b/index.ts');
    const graph = buildImportGraph(
      new Map([
        ['src/a.ts', "import './b';\nimport 'zod';"],
        ['src/b/index.ts', "import '../c.js';"],
        ['src/c.tsx', "import './a';\nimport './missing';"],
      ]),
      files,
    );
    expect([...graph.external.keys()]).toEqual(['zod']);
    expect(graph.unresolved.get('src/c.tsx')).toEqual(['./missing']);
    expect(findCycles(graph.edges)).toEqual([
      ['src/a.ts', 'src/b/index.ts', 'src/c.tsx', 'src/a.ts'],
    ]);
  });
});

describe('file tree, architecture and tool dispatch', () => {
  const files = [
    'package.json',
    'apps/web/package.json',
    'apps/web/src/index.ts',
    'apps/web/src/util.ts',
    'packages/ui/package.json',
    'packages/ui/src/index.ts',
    'README.md',
  ];
  const contents: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'root', private: true }),
    'apps/web/package.json': JSON.stringify({
      name: '@x/web',
      description: 'Web app',
      main: 'src/index.ts',
      scripts: { dev: 'x', test: 'y' },
      dependencies: { '@x/ui': 'workspace:*', zod: '^3' },
    }),
    'packages/ui/package.json': JSON.stringify({ name: '@x/ui' }),
    'apps/web/src/index.ts': "import { u } from './util.js';\nimport '@x/ui';",
    'apps/web/src/util.ts': 'export const u = 1;',
    'packages/ui/src/index.ts': '',
  };

  it('renders a tree with depth cut-off', () => {
    expect(renderTree(files, { maxDepth: 2 })).toBe(
      [
        'apps/',
        '  web/ (3 files)',
        'packages/',
        '  ui/ (2 files)',
        'package.json',
        'README.md',
      ].join('\n'),
    );
    expect(renderTree(files, { under: 'apps/web/src' })).toBe('index.ts\nutil.ts');
  });

  it('summarises modules, layers and internal dependencies', async () => {
    const md = await generateArchitecture({
      files,
      readFile: async (f) => contents[f],
      now: new Date('2026-10-18T00:00:00Z'),
    });
    expect(md).toContain('### `apps/web` — @x/web');
    expect(md).toContain('- depends on: @x/ui');
    expect(md).toContain('- applications: `apps/`');
    expect(md).toContain('scripts: dev, test');
    expect(md).toContain('`apps/web/src/util.ts` (1 importers)');
  });

  it('callTool validates arguments and fences paths', async () => {
    const backend: IntelBackend = {
      root: '/w',
      listFiles: async () => files,
      readFile: async (f) => contents[f],
      fence: (raw) =>
        raw.startsWith('..')
          ? { ok: false, reason: 'Outside the project folder' }
          : { ok: true, relative: raw },
      documentSymbols: async (f) => `symbols of ${f}`,
      workspaceSymbols: async () => '',
      diagnostics: () => '',
      runCheck: async () => '',
      readArchitecture: async () => undefined,
      writeArchitecture: async () => undefined,
    };
    await expect(
      callTool('document_symbols', { path: 'apps/web/src/index.ts' }, backend),
    ).resolves.toEqual({ text: 'symbols of apps/web/src/index.ts', isError: false });
    await expect(callTool('document_symbols', { path: '../etc' }, backend)).resolves.toEqual({
      text: 'Outside the project folder',
      isError: true,
    });
    await expect(callTool('document_symbols', {}, backend)).resolves.toMatchObject({
      isError: true,
      text: expect.stringContaining('Invalid arguments'),
    });
    await expect(callTool('nope', {}, backend)).resolves.toMatchObject({ isError: true });
    const deps = await callTool('dependencies', { path: 'apps/web' }, backend);
    expect(deps.text).toContain('workspace:*');
    const graph = await callTool('import_graph', { path: 'apps/web/src/index.ts' }, backend);
    expect(graph.text).toContain('imports: apps/web/src/util.ts');
  });
});
