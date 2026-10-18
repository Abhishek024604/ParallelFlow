// Project files that respect .gitignore (git ls-files when the folder is a repo, a walk that skips
// .git, node_modules and the root .gitignore's plain names otherwise), a compact tree view, and a
// plain text search over those files.
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { type GitRunner, runGit } from '../saras/git.js';

const ALWAYS_SKIP = new Set(['.git', 'node_modules', '.saras']);
const MAX_FILES = 20_000;

export async function listProjectFiles(root: string, run: GitRunner = runGit): Promise<string[]> {
  try {
    const out = await run(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root);
    const files = out.split('\0').filter(Boolean);
    const unique = [...new Set(files)].filter((f) => !f.split('/').some((s) => ALWAYS_SKIP.has(s)));
    return unique.sort().slice(0, MAX_FILES);
  } catch {
    return walk(root);
  }
}

async function walk(root: string): Promise<string[]> {
  let ignored = new Set<string>();
  try {
    const gi = await fsp.readFile(path.join(root, '.gitignore'), 'utf8');
    ignored = new Set(
      gi
        .split(/\r?\n/)
        .map((l) => l.trim().replace(/^\/|\/$/g, ''))
        .filter((l) => l && !l.startsWith('#') && !/[*?![]/.test(l)),
    );
  } catch {
    // no .gitignore
  }
  const out: string[] = [];
  async function visit(rel: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    const entries = await fsp
      .readdir(path.join(root, rel), { withFileTypes: true })
      .catch(() => []);
    for (const e of entries) {
      if (ALWAYS_SKIP.has(e.name) || ignored.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (ignored.has(child)) continue;
      if (e.isDirectory()) await visit(child);
      else if (e.isFile()) out.push(child);
    }
  }
  await visit('');
  return out.sort();
}

/** Render paths as an indented tree under `under`, cutting depth and entry count. */
export function renderTree(
  files: readonly string[],
  options: { under?: string; maxDepth?: number; maxEntries?: number } = {},
): string {
  const under = (options.under ?? '').replace(/^\.\/?|\/$/g, '');
  const maxDepth = options.maxDepth ?? 4;
  const maxEntries = options.maxEntries ?? 400;
  interface Node {
    children: Map<string, Node>;
    files: number;
  }
  const rootNode: Node = { children: new Map(), files: 0 };
  for (const f of files) {
    if (under && !(f === under || f.startsWith(`${under}/`))) continue;
    const rel = under ? f.slice(under.length + 1) : f;
    if (!rel) continue;
    let node = rootNode;
    for (const part of rel.split('/')) {
      node.files += 1;
      let next = node.children.get(part);
      if (!next) {
        next = { children: new Map(), files: 0 };
        node.children.set(part, next);
      }
      node = next;
    }
  }
  const lines: string[] = [];
  let truncated = false;
  const render = (node: Node, depth: number) => {
    const entries = [...node.children].sort(([a, an], [b, bn]) => {
      const ad = an.children.size > 0 ? 0 : 1;
      const bd = bn.children.size > 0 ? 0 : 1;
      return ad - bd || a.localeCompare(b);
    });
    for (const [name, child] of entries) {
      if (lines.length >= maxEntries) {
        truncated = true;
        return;
      }
      const isDir = child.children.size > 0;
      const indent = '  '.repeat(depth);
      if (isDir && depth + 1 >= maxDepth) {
        lines.push(`${indent}${name}/ (${child.files} files)`);
      } else {
        lines.push(`${indent}${name}${isDir ? '/' : ''}`);
        if (isDir) render(child, depth + 1);
      }
    }
  };
  render(rootNode, 0);
  if (truncated) lines.push(`… (cut at ${maxEntries} entries; ask for a subfolder)`);
  return lines.join('\n') || '(no files)';
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

const MAX_FILE_BYTES = 1024 * 1024;

export async function searchText(
  root: string,
  files: readonly string[],
  query: string,
  options: { regex?: boolean; caseSensitive?: boolean; maxResults?: number; under?: string } = {},
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const max = options.maxResults ?? 100;
  const flags = options.caseSensitive ? 'g' : 'gi';
  let re: RegExp;
  try {
    re = new RegExp(options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (err) {
    throw new Error(`Invalid regular expression: ${(err as Error).message}`);
  }
  const under = (options.under ?? '').replace(/^\.\/?|\/$/g, '');
  const hits: SearchHit[] = [];
  for (const file of files) {
    if (under && !file.startsWith(`${under}/`) && file !== under) continue;
    const abs = path.join(root, file);
    let buf: Buffer;
    try {
      const stat = await fsp.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      buf = await fsp.readFile(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue; // binary
    const lines = buf.toString('utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i] ?? '')) {
        hits.push({ file, line: i + 1, text: (lines[i] ?? '').trim().slice(0, 200) });
        if (hits.length >= max) return { hits, truncated: true };
      }
    }
  }
  return { hits, truncated: false };
}
