// IntelBackend on top of the running VS Code: language-server symbols, diagnostics, and project
// checks run only after the person approves the exact command.
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ApprovalBroker } from '../approvals/broker.js';
import { fencePath } from '../shared/fence.js';
import { scrubEnv } from '../shared/env.js';
import { fenceOptions } from '../guard/policy.js';
import { listProjectFiles } from './files.js';
import type { IntelBackend } from './tools.js';

const FILE_CACHE_MS = 10_000;
const SYMBOL_KINDS = Object.fromEntries(
  Object.entries(vscode.SymbolKind)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => [v, k]),
) as Record<number, string>;

export function createVscodeBackend(opts: {
  root: string;
  tmpDir: string;
  broker: ApprovalBroker;
  approvalTimeoutMs: () => number;
}): IntelBackend {
  const { root } = opts;
  const fence = fenceOptions(root);
  let cache: { at: number; files: string[] } | undefined;
  const rel = (abs: string) => path.relative(root, abs).split(path.sep).join('/');
  const inside = (abs: string) => fencePath(abs, fence).ok;

  return {
    root,
    async listFiles() {
      if (cache && Date.now() - cache.at < FILE_CACHE_MS) return cache.files;
      cache = { at: Date.now(), files: await listProjectFiles(root) };
      return cache.files;
    },
    async readFile(file) {
      const res = fencePath(file, fence);
      if (!res.ok) return undefined;
      return fsp.readFile(res.path, 'utf8').catch(() => undefined);
    },
    fence(raw) {
      const res = fencePath(raw, fence);
      return res.ok ? { ok: true, relative: res.relative } : res;
    },
    async documentSymbols(file) {
      const uri = vscode.Uri.file(path.join(root, file));
      const symbols = await vscode.commands.executeCommand<
        (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined
      >('vscode.executeDocumentSymbolProvider', uri);
      if (!symbols?.length)
        return `No symbols for ${file} (no language support, or the file is empty).`;
      const lines: string[] = [];
      const walk = (s: vscode.DocumentSymbol | vscode.SymbolInformation, depth: number) => {
        const range = 'range' in s ? s.range : s.location.range;
        lines.push(
          `${'  '.repeat(depth)}${SYMBOL_KINDS[s.kind] ?? 'Symbol'} ${s.name}  L${range.start.line + 1}-${range.end.line + 1}`,
        );
        if ('children' in s) for (const c of s.children) walk(c, depth + 1);
      };
      for (const s of symbols) walk(s, 0);
      return lines.slice(0, 500).join('\n');
    },
    async workspaceSymbols(query) {
      const symbols =
        (await vscode.commands.executeCommand<vscode.SymbolInformation[] | undefined>(
          'vscode.executeWorkspaceSymbolProvider',
          query,
        )) ?? [];
      const hits = symbols.filter((s) => inside(s.location.uri.fsPath)).slice(0, 100);
      if (hits.length === 0)
        return 'No symbols found (open a file of that language so its server starts).';
      return hits
        .map(
          (s) =>
            `${SYMBOL_KINDS[s.kind] ?? 'Symbol'} ${s.name}${s.containerName ? ` (in ${s.containerName})` : ''}  ${rel(s.location.uri.fsPath)}:${s.location.range.start.line + 1}`,
        )
        .join('\n');
    },
    diagnostics(file, severity) {
      const wanted = (d: vscode.Diagnostic) =>
        severity === 'all'
          ? d.severity <= vscode.DiagnosticSeverity.Warning
          : severity === 'error'
            ? d.severity === vscode.DiagnosticSeverity.Error
            : d.severity === vscode.DiagnosticSeverity.Warning;
      const lines: string[] = [];
      for (const [uri, diags] of vscode.languages.getDiagnostics()) {
        if (uri.scheme !== 'file' || !inside(uri.fsPath)) continue;
        const r = rel(uri.fsPath);
        if (file && r !== file) continue;
        for (const d of diags.filter(wanted)) {
          const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
          lines.push(
            `${r}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}${d.source ? ` [${d.source}]` : ''} ${d.message.split('\n')[0]}`,
          );
        }
      }
      if (lines.length === 0)
        return 'No problems reported. (VS Code only knows about files its language servers have checked; use run_check for a full check.)';
      return [`${lines.length} problem(s):`, ...lines.slice(0, 300)].join('\n');
    },
    async runCheck(check) {
      const pm = await detectPackageManager(root);
      const pkgText = await fsp
        .readFile(path.join(root, 'package.json'), 'utf8')
        .catch(() => undefined);
      const scripts = pkgText
        ? ((JSON.parse(pkgText) as { scripts?: Record<string, string> }).scripts ?? {})
        : {};
      if (!scripts[check]) return `package.json has no "${check}" script.`;
      const command = `${pm} run ${check}`;
      const answer = await opts.broker.request(
        {
          id: `check-${Date.now()}`,
          kind: 'command',
          title: 'Run this check?',
          detail: command,
          cwd: root,
          reason: 'The agent asked to run a project check',
        },
        opts.approvalTimeoutMs(),
      );
      if (!('decision' in answer) || answer.decision === 'deny') {
        return `The person did not approve "${command}"${'reason' in answer && answer.reason ? `: ${answer.reason}` : '.'}`;
      }
      return runScript(pm, check, root, opts.tmpDir);
    },
    async readArchitecture() {
      return fsp
        .readFile(path.join(root, '.saras', 'architecture.md'), 'utf8')
        .catch(() => undefined);
    },
    async writeArchitecture(md) {
      await ensureSarasDir(root);
      await fsp.writeFile(path.join(root, '.saras', 'architecture.md'), md, 'utf8');
    },
  };
}

/** .saras/ holds local state (config, architecture, temp files); its own .gitignore keeps it out of git. */
export async function ensureSarasDir(root: string): Promise<string> {
  const dir = path.join(root, '.saras');
  await fsp.mkdir(path.join(dir, 'tmp'), { recursive: true });
  const gi = path.join(dir, '.gitignore');
  await fsp.writeFile(gi, '*\n', { flag: 'wx' }).catch(() => undefined);
  return dir;
}

async function detectPackageManager(root: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  const exists = (f: string) =>
    fsp.access(path.join(root, f)).then(
      () => true,
      () => false,
    );
  if (await exists('pnpm-lock.yaml')) return 'pnpm';
  if (await exists('yarn.lock')) return 'yarn';
  return 'npm';
}

function runScript(pm: string, script: string, cwd: string, tmpDir: string): Promise<string> {
  return new Promise((resolve) => {
    // Fixed program and arguments; a shell is needed on Windows for the .cmd shims only.
    const child = spawn(pm, ['run', script], {
      cwd,
      shell: process.platform === 'win32',
      windowsHide: true,
      env: scrubEnv(process.env, { tmpDir }),
    });
    let out = '';
    const add = (b: Buffer) => {
      out += b.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const tail = out.length > 30_000 ? `…${out.slice(-30_000)}` : out;
      resolve(`${pm} run ${script} exited with ${code}\n${tail}`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`Could not run ${pm}: ${err.message}`);
    });
  });
}
