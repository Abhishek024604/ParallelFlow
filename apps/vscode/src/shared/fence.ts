// Folder fence: every path the agent's tools touch must resolve inside the opened project folder.
// Pure (the file system and platform are injected) so the Pi guard extension and the unit tests use
// the same code. It mirrors how Pi itself turns a tool argument into a path (strip "@", Unicode
// spaces, Git Bash drive paths, "~", file:// URLs) and then resolves symlinks before comparing.
import * as nodePath from 'node:path';

export type FencePlatform = 'win32' | 'posix';

export interface FenceFs {
  /** Like fs.lstatSync: true when the entry itself exists (a dangling symlink counts). */
  lexists(p: string): boolean;
  /** Like fs.realpathSync.native: throws when the path (or a symlink target) does not exist. */
  realpath(p: string): string;
}

export interface FenceOptions {
  root: string;
  platform: FencePlatform;
  homedir: string;
  fs: FenceFs;
}

export type FenceResult =
  { ok: true; path: string; relative: string } | { ok: false; reason: string };

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9]|conin\$|conout\$)(\..*)?$/i;

function pathApi(platform: FencePlatform): nodePath.PlatformPath {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

/** Git Bash, MSYS, Cygwin and WSL drive paths (/c/x, /mnt/c/x, /cygdrive/c/x) as Windows paths. */
function windowsShellPath(p: string): string {
  if (!p.startsWith('/') || p.startsWith('//') || p.includes('\\')) return p;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
  if (!match) return p;
  const suffix = match[2]?.replaceAll('/', '\\') ?? '';
  return `${(match[1] ?? '').toUpperCase()}:\\${suffix}`;
}

function fromFileUrl(p: string, platform: FencePlatform): string | { reason: string } {
  const match = /^file:\/\/([^/]*)(\/.*)?$/i.exec(p);
  if (!match) return { reason: 'Unsupported file URL' };
  const host = match[1] ?? '';
  if (host !== '' && host.toLowerCase() !== 'localhost')
    return { reason: 'Network paths are not allowed' };
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[2] ?? '/');
  } catch {
    return { reason: 'Malformed file URL' };
  }
  if (platform === 'win32') {
    if (/^\/[a-z]:/i.test(decoded)) decoded = decoded.slice(1);
    decoded = decoded.replaceAll('/', '\\');
  }
  return decoded;
}

/** Turn a raw tool argument into the path string Pi would resolve, or a reason to block it. */
export function normalizeToolPath(
  raw: string,
  platform: FencePlatform,
  homedir: string,
): string | { reason: string } {
  if (raw.includes('\0')) return { reason: 'Path contains a NUL byte' };
  let p = raw.replace(UNICODE_SPACES, ' ');
  if (p.startsWith('@')) p = p.slice(1);
  if (p.trim() === '') p = '.';
  if (/^file:/i.test(p)) {
    const converted = fromFileUrl(p, platform);
    if (typeof converted !== 'string') return converted;
    p = converted;
  }
  if (platform === 'win32') p = windowsShellPath(p);
  if (p === '~') return homedir;
  if (p.startsWith('~/') || (platform === 'win32' && p.startsWith('~\\'))) {
    return pathApi(platform).join(homedir, p.slice(2));
  }
  if (p.startsWith('~')) return { reason: 'Other users’ home folders are outside the project' };
  if (platform === 'win32') {
    if (/^[\\/]{2}/.test(p)) return { reason: 'Network and device paths are not allowed' };
    if (/^[a-z]:(?![\\/])/i.test(p)) return { reason: 'Drive-relative paths are not allowed' };
    const rest = /^[a-z]:/i.test(p) ? p.slice(2) : p;
    if (rest.includes(':')) return { reason: 'Alternate data streams are not allowed' };
    const segments = rest.split(/[\\/]+/).filter(Boolean);
    if (segments.some((s) => WINDOWS_RESERVED.test(s.replace(/[ .]+$/, '')))) {
      return { reason: 'Windows device names are not allowed' };
    }
  }
  return p;
}

function isInside(api: nodePath.PlatformPath, root: string, candidate: string): string | undefined {
  const rel = api.relative(root, candidate);
  if (rel === '') return '';
  if (api.isAbsolute(rel)) return undefined;
  const first = rel.split(api.sep)[0];
  if (first === '..') return undefined;
  return rel;
}

/** Resolve the deepest existing ancestor through realpath and re-append the missing tail. */
function realResolve(
  api: nodePath.PlatformPath,
  fs: FenceFs,
  abs: string,
): string | { reason: string } {
  const tail: string[] = [];
  let current = abs;
  for (;;) {
    if (fs.lexists(current)) {
      let real: string;
      try {
        real = fs.realpath(current);
      } catch {
        return { reason: 'Broken symlink' };
      }
      return tail.length === 0 ? real : api.join(real, ...tail.reverse());
    }
    const parent = api.dirname(current);
    if (parent === current) return abs;
    tail.push(api.basename(current));
    current = parent;
  }
}

/** Check one path argument. `ok` carries the real absolute path and its folder-relative form. */
export function fencePath(raw: string, opts: FenceOptions): FenceResult {
  const api = pathApi(opts.platform);
  const normalized = normalizeToolPath(raw, opts.platform, opts.homedir);
  if (typeof normalized !== 'string') return { ok: false, reason: normalized.reason };
  const abs = api.isAbsolute(normalized)
    ? api.resolve(normalized)
    : api.resolve(opts.root, normalized);

  const lexicalRoot = api.resolve(opts.root);
  if (isInside(api, lexicalRoot, abs) === undefined) {
    return { ok: false, reason: `Outside the project folder: ${raw}` };
  }
  let realRoot: string;
  try {
    realRoot = opts.fs.realpath(lexicalRoot);
  } catch {
    return { ok: false, reason: 'The project folder is not available' };
  }
  const real = realResolve(api, opts.fs, abs);
  if (typeof real !== 'string') return { ok: false, reason: real.reason };
  const rel = isInside(api, realRoot, real);
  if (rel === undefined) {
    return { ok: false, reason: `Resolves outside the project folder (symlink): ${raw}` };
  }
  return { ok: true, path: real, relative: rel.split(api.sep).join('/') };
}

/** A glob or search pattern must not climb out of the folder or name an absolute location. */
export function checkPattern(pattern: string, platform: FencePlatform): string | undefined {
  if (pattern.includes('\0')) return 'Pattern contains a NUL byte';
  const p = pattern.replace(/^@/, '');
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return 'Patterns may not contain ".."';
  if (p.startsWith('/') || p.startsWith('\\') || p.startsWith('~')) {
    return 'Patterns must be relative to the project folder';
  }
  if (platform === 'win32' && /^[a-z]:/i.test(p))
    return 'Patterns must be relative to the project folder';
  return undefined;
}

export type WriteRule = 'block' | 'ask' | 'allow';

/**
 * What a write to a folder-relative path needs. Writing into git internals could plant hooks that
 * run on the host, so `.git` is never writable; editor, container, CI and agent config ask first.
 */
export function writeRule(relative: string, platform: FencePlatform): WriteRule {
  const rel = platform === 'win32' ? relative.toLowerCase() : relative;
  const segments = rel.split('/').filter(Boolean);
  if (segments.includes('.git')) return 'block';
  const top = segments[0] ?? '';
  if (['.vscode', '.devcontainer', '.pi', '.saras', '.husky'].includes(top)) return 'ask';
  if (top === '.devcontainer.json' || top === '.envrc' || top === '.gitmodules') return 'ask';
  if (top === '.github' && segments[1] === 'workflows') return 'ask';
  return 'allow';
}
