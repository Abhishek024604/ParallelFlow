import * as path from 'node:path';

// "Build in VS Code" on the arena page opens vscode://parallelflow.parallelflow-vscode/start
// ?arena=<id>&code=<device code>&web=<ParallelFlow web origin> (contracts vscodeStartLink). The
// extension signs in with the code (already approved for the person, single use), clones the
// arena's repository into ~/ParallelFlow/<arena> and opens it ready for a task. A link is data
// from outside VS Code: it is checked here, and a link for another ParallelFlow server is never
// followed without the person's yes.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEVICE_CODE = /^[A-Za-z0-9_-]{20,200}$/;

export interface StartLink {
  arenaId: string;
  /** The approved device code; absent when the person is already signed in on the web side. */
  code?: string;
  /** The ParallelFlow web origin the link came from. */
  web: string;
  /** Whether `web` is the server this extension is set up for (parallelflow.url). */
  sameServer: boolean;
}

/** The origin of a URL, or null when it is not http(s). */
export function originOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** A /start link's query, checked; null when it is not one. */
export function parseStartLink(query: string, configuredUrl: string): StartLink | null {
  const q = new URLSearchParams(query);
  const arenaId = q.get('arena') ?? '';
  const code = q.get('code') ?? '';
  const web = originOf(q.get('web') ?? '');
  if (!UUID.test(arenaId) || !web) return null;
  if (code && !DEVICE_CODE.test(code)) return null;
  return {
    arenaId: arenaId.toLowerCase(),
    ...(code && { code }),
    web,
    sameServer: originOf(configuredUrl) === web,
  };
}

/** A folder name for an arena: its key, else its name, in lower case with dashes. */
export function arenaFolderName(arena: { key?: string | null; name: string }): string {
  const base = (arena.key || arena.name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return base || 'arena';
}

/** Where an arena is built by default: ~/ParallelFlow/<arena>. */
export function defaultBuildFolder(
  home: string,
  arena: { key?: string | null; name: string },
): string {
  return path.join(home, 'ParallelFlow', arenaFolderName(arena));
}
