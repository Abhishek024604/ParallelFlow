// Layer 2: codebase intelligence tools the agent calls through the extension's MCP server. Each
// tool validates its arguments, keeps paths inside the folder, and returns plain text sized for a
// model. VS Code specifics (symbols, diagnostics, running checks) sit behind IntelBackend.
import { z } from 'zod';
import { analyzeDirectory, formatReports, MANIFEST_FILES } from './deps.js';
import { generateArchitecture } from './architecture.js';
import { renderTree, searchText } from './files.js';
import { buildImportGraph, formatGraph, isSourceFile } from './imports.js';

export interface IntelBackend {
  root: string;
  listFiles(): Promise<string[]>;
  readFile(rel: string): Promise<string | undefined>;
  /** Folder-relative, `/`-separated path for an argument, or an error message. */
  fence(raw: string): { ok: true; relative: string } | { ok: false; reason: string };
  documentSymbols(rel: string): Promise<string>;
  workspaceSymbols(query: string): Promise<string>;
  diagnostics(rel: string | undefined, severity: 'error' | 'warning' | 'all'): string;
  runCheck(check: 'typecheck' | 'lint' | 'test'): Promise<string>;
  readArchitecture(): Promise<string | undefined>;
  writeArchitecture(markdown: string): Promise<void>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean };
  run(args: unknown, backend: IntelBackend): Promise<string>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const bool = (description: string) => ({ type: 'boolean', description });

function fenced(backend: IntelBackend, raw: string | undefined): string {
  if (raw === undefined || raw === '' || raw === '.') return '';
  const res = backend.fence(raw);
  if (!res.ok) throw new Error(res.reason);
  return res.relative;
}

const readOnly = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: ToolSpec[] = [
  {
    name: 'file_tree',
    description:
      'The project file tree (respects .gitignore). Use it first to orient yourself. Optional subfolder and depth.',
    inputSchema: obj({
      path: str('Subfolder, relative to the project'),
      depth: int('Folder depth, default 4'),
    }),
    annotations: readOnly,
    async run(args, b) {
      const a = z
        .object({ path: z.string().optional(), depth: z.number().int().min(1).max(12).optional() })
        .parse(args);
      const under = fenced(b, a.path);
      return renderTree(await b.listFiles(), { under, maxDepth: a.depth ?? 4 });
    },
  },
  {
    name: 'document_symbols',
    description:
      'Outline of one file from the language server: classes, functions, methods with line numbers.',
    inputSchema: obj({ path: str('File path, relative to the project') }, ['path']),
    annotations: readOnly,
    async run(args, b) {
      const a = z.object({ path: z.string().min(1) }).parse(args);
      return b.documentSymbols(fenced(b, a.path));
    },
  },
  {
    name: 'workspace_symbols',
    description: 'Find classes, functions and types by name across the project (language server).',
    inputSchema: obj({ query: str('Symbol name or part of it') }, ['query']),
    annotations: readOnly,
    async run(args, b) {
      const a = z.object({ query: z.string().min(1).max(200) }).parse(args);
      return b.workspaceSymbols(a.query);
    },
  },
  {
    name: 'search_text',
    description:
      'Search file contents (respects .gitignore). Literal by default; set regex for a regular expression.',
    inputSchema: obj(
      {
        query: str('Text or regular expression'),
        regex: bool('Treat query as a regular expression'),
        case_sensitive: bool('Match case'),
        path: str('Only search under this subfolder'),
        max_results: int('Default 100'),
      },
      ['query'],
    ),
    annotations: readOnly,
    async run(args, b) {
      const a = z
        .object({
          query: z.string().min(1).max(500),
          regex: z.boolean().optional(),
          case_sensitive: z.boolean().optional(),
          path: z.string().optional(),
          max_results: z.number().int().min(1).max(500).optional(),
        })
        .parse(args);
      const { hits, truncated } = await searchText(b.root, await b.listFiles(), a.query, {
        regex: a.regex,
        caseSensitive: a.case_sensitive,
        under: fenced(b, a.path),
        maxResults: a.max_results,
      });
      if (hits.length === 0) return 'No matches.';
      return [
        ...hits.map((h) => `${h.file}:${h.line}: ${h.text}`),
        ...(truncated ? ['… more matches; narrow the search'] : []),
      ].join('\n');
    },
  },
  {
    name: 'diagnostics',
    description:
      'Current errors and warnings VS Code knows about (type checker, linters), for the project or one file.',
    inputSchema: obj({
      path: str('File path; omit for the whole project'),
      severity: { type: 'string', enum: ['error', 'warning', 'all'] },
    }),
    annotations: readOnly,
    async run(args, b) {
      const a = z
        .object({
          path: z.string().optional(),
          severity: z.enum(['error', 'warning', 'all']).optional(),
        })
        .parse(args);
      return b.diagnostics(a.path ? fenced(b, a.path) : undefined, a.severity ?? 'all');
    },
  },
  {
    name: 'run_check',
    description:
      'Run the project type check, lint or tests (its package.json script) and return the output. The person approves each run.',
    inputSchema: obj({ check: { type: 'string', enum: ['typecheck', 'lint', 'test'] } }, ['check']),
    annotations: { readOnlyHint: false, openWorldHint: false },
    async run(args, b) {
      const a = z.object({ check: z.enum(['typecheck', 'lint', 'test']) }).parse(args);
      return b.runCheck(a.check);
    },
  },
  {
    name: 'dependencies',
    description:
      'Direct dependencies from the manifests in a folder (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml) with versions locked by the lockfile.',
    inputSchema: obj({ path: str('Folder, relative to the project; default the root') }),
    annotations: readOnly,
    async run(args, b) {
      const a = z.object({ path: z.string().optional() }).parse(args);
      const dir = fenced(b, a.path);
      const prefix = dir ? `${dir}/` : '';
      const files: Record<string, string | undefined> = {};
      for (const name of MANIFEST_FILES) files[name] = await b.readFile(prefix + name);
      // A pnpm workspace keeps one lockfile at the root.
      const rootPnpm = dir ? await b.readFile('pnpm-lock.yaml') : undefined;
      return formatReports(dir || '.', analyzeDirectory(files, dir || '.', rootPnpm));
    },
  },
  {
    name: 'import_graph',
    description:
      'TypeScript/JavaScript import graph: the most imported files, external packages and cycles, or one file’s imports and importers.',
    inputSchema: obj({ path: str('Focus on this file') }),
    annotations: readOnly,
    async run(args, b) {
      const a = z.object({ path: z.string().optional() }).parse(args);
      const focus = a.path ? fenced(b, a.path) : undefined;
      const files = await b.listFiles();
      const texts = new Map<string, string>();
      for (const f of files.filter(isSourceFile).slice(0, 3000)) {
        const t = await b.readFile(f);
        if (t !== undefined && t.length < 512 * 1024) texts.set(f, t);
      }
      return formatGraph(buildImportGraph(texts, new Set(files)), focus);
    },
  },
  {
    name: 'architecture',
    description:
      'The project architecture summary (modules, entry points, layers, internal dependencies), cached in .parallelflow/architecture.md. Set refresh after large changes.',
    inputSchema: obj({ refresh: bool('Regenerate instead of using the cached summary') }),
    annotations: readOnly,
    async run(args, b) {
      const a = z.object({ refresh: z.boolean().optional() }).parse(args);
      if (!a.refresh) {
        const cached = await b.readArchitecture();
        if (cached) return cached;
      }
      const md = await refreshArchitecture(b);
      return md;
    },
  },
];

export async function refreshArchitecture(b: IntelBackend): Promise<string> {
  const md = await generateArchitecture({
    files: await b.listFiles(),
    readFile: (f) => b.readFile(f),
  });
  await b.writeArchitecture(md);
  return md;
}

const OUTPUT_LIMIT = 40_000;

/** Run a tool by name. Errors become a short message for the model, never a stack trace. */
export async function callTool(
  name: string,
  args: unknown,
  backend: IntelBackend,
): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool ${name}`, isError: true };
  try {
    const text = await tool.run(args ?? {}, backend);
    return {
      text: text.length > OUTPUT_LIMIT ? `${text.slice(0, OUTPUT_LIMIT)}\n… (output cut)` : text,
      isError: false,
    };
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        text: `Invalid arguments: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        isError: true,
      };
    }
    return { text: (err as Error).message || 'The tool failed', isError: true };
  }
}
