import * as nodePath from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPattern, fencePath, type FenceFs, type FenceOptions, writeRule } from './fence.js';

/** An in-memory file system: entries are dirs, files, or symlinks with an absolute target. */
function fakeFs(platform: 'win32' | 'posix', entries: Record<string, string | null>): FenceFs {
  const api = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const key = (p: string) => (platform === 'win32' ? api.resolve(p).toLowerCase() : api.resolve(p));
  const table = new Map<string, string | null>();
  for (const [p, target] of Object.entries(entries)) table.set(key(p), target);

  function realpath(p: string, depth = 0): string {
    if (depth > 20) throw new Error('ELOOP');
    const abs = api.resolve(p);
    const { root } = api.parse(abs);
    const parts = abs.slice(root.length).split(api.sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      const next = api.join(current, part);
      if (!table.has(key(next))) throw new Error(`ENOENT ${next}`);
      const target = table.get(key(next));
      current = target ? realpath(target, depth + 1) : next;
    }
    return current;
  }
  return {
    lexists: (p) => table.has(key(p)) || api.parse(api.resolve(p)).root === api.resolve(p),
    realpath,
  };
}

describe('fencePath (POSIX)', () => {
  const opts: FenceOptions = {
    root: '/work/app',
    platform: 'posix',
    homedir: '/home/me',
    fs: fakeFs('posix', {
      '/work': null,
      '/work/app': null,
      '/work/app/src': null,
      '/work/app/src/a.ts': null,
      '/work/app/link-out': '/etc',
      '/work/app/link-in': '/work/app/src',
      '/work/app/dangling': '/nowhere/x',
      '/etc': null,
      '/etc/passwd': null,
    }),
  };

  it('allows relative, absolute and new paths inside the folder', () => {
    expect(fencePath('src/a.ts', opts)).toMatchObject({
      ok: true,
      path: '/work/app/src/a.ts',
      relative: 'src/a.ts',
    });
    expect(fencePath('/work/app/src/new/file.ts', opts)).toMatchObject({
      ok: true,
      relative: 'src/new/file.ts',
    });
    expect(fencePath('.', opts)).toMatchObject({ ok: true, relative: '' });
    expect(fencePath('', opts)).toMatchObject({ ok: true, relative: '' });
    expect(fencePath('@src/a.ts', opts)).toMatchObject({ ok: true, relative: 'src/a.ts' });
    expect(fencePath('file:///work/app/src/a.ts', opts)).toMatchObject({ ok: true });
  });

  it('blocks parent traversal, absolute paths and home', () => {
    expect(fencePath('../other', opts).ok).toBe(false);
    expect(fencePath('src/../../other', opts).ok).toBe(false);
    expect(fencePath('/etc/passwd', opts).ok).toBe(false);
    expect(fencePath('/work/app-evil/x', opts).ok).toBe(false);
    expect(fencePath('~/.ssh/id_rsa', opts).ok).toBe(false);
    expect(fencePath('~root/.ssh', opts).ok).toBe(false);
    expect(fencePath('file:///etc/passwd', opts).ok).toBe(false);
    expect(fencePath('file://host/share/x', opts).ok).toBe(false);
    expect(fencePath('src/a\0.ts', opts).ok).toBe(false);
  });

  it('follows symlinks: out is blocked, in is allowed, dangling is blocked', () => {
    expect(fencePath('link-out/passwd', opts)).toMatchObject({ ok: false });
    expect(fencePath('link-out', opts).ok).toBe(false);
    expect(fencePath('link-in/a.ts', opts)).toMatchObject({ ok: true, path: '/work/app/src/a.ts' });
    expect(fencePath('dangling', opts)).toMatchObject({ ok: false, reason: 'Broken symlink' });
    expect(fencePath('link-out/new-file', opts).ok).toBe(false);
  });
});

describe('fencePath (Windows)', () => {
  const opts: FenceOptions = {
    root: 'c:\\Work\\App',
    platform: 'win32',
    homedir: 'C:\\Users\\me',
    fs: fakeFs('win32', {
      'C:\\Work': null,
      'C:\\Work\\App': null,
      'C:\\Work\\App\\src': null,
      'C:\\Work\\App\\src\\a.ts': null,
      'C:\\Work\\App\\junction': 'D:\\Secrets',
      'D:\\Secrets': null,
    }),
  };

  it('allows inside paths with any case and slash style', () => {
    expect(fencePath('src\\a.ts', opts)).toMatchObject({ ok: true, relative: 'src/a.ts' });
    expect(fencePath('C:/work/app/SRC/a.ts', opts).ok).toBe(true);
    expect(fencePath('/c/Work/App/src/a.ts', opts).ok).toBe(true);
    expect(fencePath('/mnt/c/Work/App/src', opts).ok).toBe(true);
    expect(fencePath('file:///C:/Work/App/src/a.ts', opts).ok).toBe(true);
  });

  it('blocks other drives, UNC, device and drive-relative paths', () => {
    expect(fencePath('D:\\Secrets\\x', opts).ok).toBe(false);
    expect(fencePath('\\\\server\\share\\x', opts)).toMatchObject({ ok: false });
    expect(fencePath('//server/share/x', opts).ok).toBe(false);
    expect(fencePath('\\\\?\\C:\\Work\\App\\src', opts).ok).toBe(false);
    expect(fencePath('\\\\.\\PhysicalDrive0', opts).ok).toBe(false);
    expect(fencePath('C:secret.txt', opts)).toMatchObject({
      ok: false,
      reason: 'Drive-relative paths are not allowed',
    });
    expect(fencePath('\\Windows\\System32', opts).ok).toBe(false);
    expect(fencePath('/d/Secrets', opts).ok).toBe(false);
    expect(fencePath('..\\App2', opts).ok).toBe(false);
    expect(fencePath('~\\Documents', opts).ok).toBe(false);
  });

  it('blocks alternate data streams, device names and junctions out of the folder', () => {
    expect(fencePath('src\\a.ts:hidden', opts).ok).toBe(false);
    expect(fencePath('src\\NUL', opts).ok).toBe(false);
    expect(fencePath('con.txt', opts).ok).toBe(false);
    expect(fencePath('junction\\x', opts)).toMatchObject({ ok: false });
  });
});

describe('checkPattern and writeRule', () => {
  it('rejects patterns that climb out or are absolute', () => {
    expect(checkPattern('**/*.ts', 'posix')).toBeUndefined();
    expect(checkPattern('../**', 'posix')).toBeDefined();
    expect(checkPattern('src/../../x', 'posix')).toBeDefined();
    expect(checkPattern('/etc/*', 'posix')).toBeDefined();
    expect(checkPattern('C:/x/*', 'win32')).toBeDefined();
  });

  it('never writes .git, asks for config folders', () => {
    expect(writeRule('.git/hooks/pre-commit', 'posix')).toBe('block');
    expect(writeRule('sub/.git/config', 'posix')).toBe('block');
    expect(writeRule('.GIT/config', 'win32')).toBe('block');
    expect(writeRule('.vscode/tasks.json', 'posix')).toBe('ask');
    expect(writeRule('.devcontainer/devcontainer.json', 'posix')).toBe('ask');
    expect(writeRule('.github/workflows/ci.yml', 'posix')).toBe('ask');
    expect(writeRule('src/a.ts', 'posix')).toBe('allow');
    expect(writeRule('.github/CODEOWNERS', 'posix')).toBe('allow');
  });
});
