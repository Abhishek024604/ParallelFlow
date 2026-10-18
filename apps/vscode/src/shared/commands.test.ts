import { describe, expect, it } from 'vitest';
import { isCompound, matchAllowlist, tokenize } from './commands.js';

const ALLOW = ['git status', 'git diff *', 'ls', 'ls *', 'cat *', 'pnpm test', 'tsc --noEmit'];
const inside = (arg: string) =>
  !arg.startsWith('/') && !arg.startsWith('..') && !arg.startsWith('~');

describe('tokenize', () => {
  it('splits on whitespace with quotes', () => {
    expect(tokenize(`git  diff "a b" 'c'`)).toEqual(['git', 'diff', 'a b', 'c']);
    expect(tokenize('cat "unterminated')).toBeNull();
    expect(tokenize('')).toEqual([]);
  });
});

describe('isCompound', () => {
  it.each([
    'ls; rm -rf /',
    'ls && whoami',
    'ls || true',
    'ls | sh',
    'echo `id`',
    'echo $(id)',
    'cat a > b',
    'cat < a',
    'ls &',
    'ls\nrm x',
    'echo $HOME',
    'cat {a,/etc/passwd}',
    'cmd /c dir ^& del',
    'echo %USERPROFILE%',
    'ls # comment',
  ])('detects %j', (cmd) => {
    expect(isCompound(cmd)).toBe(true);
  });

  it('accepts plain commands', () => {
    expect(isCompound('git status')).toBe(false);
    expect(isCompound('cat src/a.ts')).toBe(false);
  });
});

describe('matchAllowlist', () => {
  it('auto-approves exact and wildcard matches with inside paths', () => {
    expect(matchAllowlist('git status', ALLOW, inside).auto).toBe(true);
    expect(matchAllowlist('  git status  ', ALLOW, inside).auto).toBe(true);
    expect(matchAllowlist('pnpm test', ALLOW, inside).auto).toBe(true);
    expect(matchAllowlist('cat src/a.ts README.md', ALLOW, inside).auto).toBe(true);
    expect(matchAllowlist('git diff --stat src', ALLOW, inside).auto).toBe(true);
    expect(matchAllowlist('ls', ALLOW, inside).auto).toBe(true);
  });

  it('asks for anything else', () => {
    expect(matchAllowlist('git status --porcelain', ALLOW, inside).auto).toBe(false); // exact entry
    expect(matchAllowlist('git push', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('pnpm test && curl x', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('cat ../secret', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('cat /etc/passwd', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('cat ~/.ssh/id_rsa', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('git diff --output=/tmp/x', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('ls .*', ALLOW, inside)).toMatchObject({
      auto: false,
      reason: 'Uses wildcards',
    });
    expect(matchAllowlist('FOO=1 pnpm test', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('cat "a;b"', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('tsc --noEmit --watch', ALLOW, inside).auto).toBe(false);
    expect(matchAllowlist('gitstatus', ALLOW, inside).auto).toBe(false);
  });
});
