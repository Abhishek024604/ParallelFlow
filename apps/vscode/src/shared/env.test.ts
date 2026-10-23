import { describe, expect, it } from 'vitest';
import { isSecretName, scrubEnv } from './env.js';

describe('scrubEnv', () => {
  const host = {
    PATH: '/usr/bin',
    Path: 'C:\\Windows',
    HOME: '/home/me',
    USERPROFILE: 'C:\\Users\\me',
    SystemRoot: 'C:\\Windows',
    ComSpec: 'C:\\Windows\\system32\\cmd.exe',
    LANG: 'en_US.UTF-8',
    OPENROUTER_API_KEY: 'sk-or-1',
    ANTHROPIC_API_KEY: 'sk-ant',
    DATABASE_URL: 'postgres://x',
    AWS_SECRET_ACCESS_KEY: 'a',
    AWS_PROFILE: 'p',
    GITHUB_TOKEN: 'ghp',
    NODE_OPTIONS: '--require evil.js',
    VSCODE_IPC_HOOK: '/tmp/x',
    TEMP: 'C:\\Users\\me\\AppData\\Local\\Temp',
    RANDOM_THING: 'x',
    UNDEFINED: undefined,
  };

  it('keeps only allowlisted names and points temp to the folder', () => {
    const env = scrubEnv(host, { tmpDir: '/work/app/.parallelflow/tmp' });
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      HOME: '/home/me',
      USERPROFILE: 'C:\\Users\\me',
      SystemRoot: 'C:\\Windows',
      ComSpec: 'C:\\Windows\\system32\\cmd.exe',
      LANG: 'en_US.UTF-8',
      TEMP: '/work/app/.parallelflow/tmp',
      TMP: '/work/app/.parallelflow/tmp',
      TMPDIR: '/work/app/.parallelflow/tmp',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('adds caller variables after scrubbing', () => {
    const env = scrubEnv(host, { tmpDir: '/t', set: { PI_OFFLINE: '1' } });
    expect(env.PI_OFFLINE).toBe('1');
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it('recognises secret-looking names', () => {
    for (const n of [
      'OPENAI_API_KEY',
      'MY_TOKEN',
      'DB_PASSWORD',
      'REDIS_URL',
      'GH_TOKEN',
      'aws_region',
    ]) {
      expect(isSecretName(n)).toBe(true);
    }
    for (const n of ['PATH', 'HOME', 'LANG', 'SystemRoot']) expect(isSecretName(n)).toBe(false);
  });
});
