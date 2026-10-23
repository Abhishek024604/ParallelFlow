import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Git } from './git.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t.io', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** An "arena repo" with README.md on main, bundled like the server does. */
function arenaBundle(): string {
  const repo = mkdtempSync(join(tmpdir(), 'parallelflow-arena-'));
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Arena\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  const file = join(mkdtempSync(join(tmpdir(), 'parallelflow-b-')), 'arena.bundle');
  git(repo, 'bundle', 'create', file, '--all');
  return file;
}

describe('connecting a folder to the arena repo', () => {
  it('checks out main in an empty folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallelflow-empty-'));
    expect(await new Git(dir).connectToBundle(arenaBundle())).toBe('checked-out');
    expect(readFileSync(join(dir, 'README.md'), 'utf8').trim()).toBe('# Arena');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    expect(git(dir, 'status', '--porcelain').trim()).toBe('');
  });

  it('keeps existing files, restores the arena files and shows the rest as changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'parallelflow-full-'));
    writeFileSync(join(dir, 'app.js'), 'console.log(1)\n');
    expect(await new Git(dir).connectToBundle(arenaBundle())).toBe('kept-files');
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe('console.log(1)\n');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(git(dir, 'status', '--porcelain').trim()).toBe('?? app.js');
    expect(await new Git(dir).hasCommit(git(dir, 'rev-parse', 'HEAD').trim())).toBe(true);
  });
});
