import { parse } from 'yaml';
import { ARTIFACT_STATUSES, classifyPath } from './layout.js';
import { inputHash, readFrontmatter } from './markdown.js';
import { type Component, parseModel, readModel } from './model.js';
import type { ArchStore } from './store.js';

// swa_validate: the checks a tool can do instead of the model guessing. Frontmatter on every
// Markdown artifact, well-formed IDs, no duplicate IDs, and no citation of an ID that does not exist.
// A gate is approved only when its files pass (approve.ts).

/** FR-001, NFR-12, CON-3, CMP-003, ADR-0001. */
export const ID_PATTERN = /\b(FR|NFR|CON|CMP|ADR)-\d{1,4}\b/g;

export interface Problem {
  path: string;
  problem: string;
}

/** IDs a file defines: requirement table rows and headings in the drivers, ADR files, model components. */
export async function definedIds(store: ArchStore): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const drivers = await store.read('00-drivers.md');
  if (drivers) {
    for (const line of drivers.split(/\r?\n/)) {
      const m = /^\s*(?:\|\s*|#{2,6}\s+|[-*]\s+)\**((?:FR|NFR|CON)-\d{1,4})\b/.exec(line);
      if (m?.[1] && !ids.has(m[1])) ids.set(m[1], '00-drivers.md');
    }
  }
  for (const path of await store.list()) {
    const adr = /^decisions\/(ADR-\d{4})-/.exec(path);
    if (adr?.[1]) ids.set(adr[1], path);
  }
  for (const c of await modelComponents(store)) ids.set(c.id, 'model.yaml');
  return ids;
}

/** model.yaml components, for the IDs they define (model.ts parses the whole model). */
export async function modelComponents(store: ArchStore): Promise<Component[]> {
  return (await readModel(store))?.model.components ?? [];
}

/** The frontmatter `inputs`: `[path]` or `[{path, hash}]`. */
export function frontmatterInputs(
  data: Record<string, unknown>,
): { path: string; hash?: string }[] {
  const raw = data['inputs'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((i) =>
      typeof i === 'string'
        ? { path: i }
        : i && typeof i === 'object' && typeof (i as { path?: unknown }).path === 'string'
          ? {
              path: (i as { path: string }).path,
              ...(typeof (i as { hash?: unknown }).hash === 'string' && {
                hash: (i as { hash: string }).hash,
              }),
            }
          : null,
    )
    .filter((i): i is { path: string; hash?: string } => i !== null);
}

export function checkFrontmatter(path: string, text: string): Problem[] {
  const fm = readFrontmatter(text);
  const out: Problem[] = [];
  const say = (problem: string) => out.push({ path, problem });
  if (fm.error) {
    say(fm.error);
    return out;
  }
  const d = fm.data;
  if (!Object.keys(d).length) {
    say('no YAML frontmatter (id, status, version, owner, inputs)');
    return out;
  }
  if (typeof d['id'] !== 'string' || !d['id'].trim()) say('frontmatter `id` is missing');
  if (!ARTIFACT_STATUSES.includes(d['status'] as never)) {
    say(`frontmatter \`status\` must be one of ${ARTIFACT_STATUSES.join(', ')}`);
  }
  if (typeof d['version'] !== 'number' && typeof d['version'] !== 'string') {
    say('frontmatter `version` is missing');
  }
  if (typeof d['owner'] !== 'string') say('frontmatter `owner` is missing');
  if (path !== '00-drivers.md' && !Array.isArray(d['inputs'])) {
    say('frontmatter `inputs` (the files it was built from) is missing');
  }
  const adr = /^decisions\/(ADR-\d{4})-/.exec(path);
  if (adr && d['id'] !== adr[1]) say(`frontmatter \`id\` must be ${adr[1]} (the file name)`);
  return out;
}

/** Validates the given paths (default: every artifact). */
export async function validate(store: ArchStore, only?: readonly string[]): Promise<Problem[]> {
  const all = await store.list();
  const paths = (only ?? all).filter((p) => classifyPath(p).kind === 'artifact');
  const ids = await definedIds(store);
  const problems: Problem[] = [];

  const drivers = await store.read('00-drivers.md');
  if (drivers && (!only || only.includes('00-drivers.md'))) {
    const seen = new Map<string, number>();
    for (const line of drivers.split(/\r?\n/)) {
      const m = /^\s*\|\s*\**((?:FR|NFR|CON)-\d{1,4})\b/.exec(line);
      if (m?.[1]) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
    }
    for (const [id, n] of seen) {
      if (n > 1) problems.push({ path: '00-drivers.md', problem: `${id} is defined ${n} times` });
    }
  }

  for (const path of paths) {
    const text = await store.read(path);
    if (text === null) continue;
    if (path.endsWith('.md')) problems.push(...checkFrontmatter(path, text));
    if (path.endsWith('.yaml') || path.endsWith('.yml')) {
      try {
        parse(text);
      } catch (err) {
        problems.push({
          path,
          problem: `not valid YAML (${(err as Error).message.split('\n')[0]})`,
        });
        continue;
      }
    }
    if (path === 'model.yaml') {
      problems.push(...parseModel(text).problems.map((problem) => ({ path, problem })));
    }
    const cited = new Set(text.match(ID_PATTERN) ?? []);
    const unknown = [...cited].filter((id) => !ids.has(id));
    if (unknown.length) {
      problems.push({
        path,
        problem: `cites IDs that are not defined anywhere: ${unknown.sort().join(', ')}`,
      });
    }
  }
  return problems;
}

export const renderProblems = (problems: readonly Problem[]): string =>
  problems.length
    ? problems.map((p) => `- arch/${p.path}: ${p.problem}`).join('\n')
    : 'No problems found.';

/**
 * Fills `inputs` hashes: `inputs: [inputs/srs.md]` becomes `[{path, hash}]` with the current
 * content hash of each (impact analysis compares them later). Unknown paths keep no hash.
 */
export async function hashInputs(
  store: ArchStore,
  data: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  if (!Array.isArray(data['inputs'])) return null;
  const inputs = frontmatterInputs(data);
  const out = [];
  for (const i of inputs) {
    const path = i.path.replace(/^arch\//, '');
    const text = await store.read(path).catch(() => null);
    out.push(text === null ? { path } : { path, hash: inputHash(text) });
  }
  return { ...data, inputs: out };
}
