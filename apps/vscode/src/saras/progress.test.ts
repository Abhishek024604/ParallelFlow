import { describe, expect, it } from 'vitest';
import type { Clock } from '../approvals/broker.js';
import { isSafeBranch } from './git.js';
import { buildPiLaunch, nodeVersionOk } from '../pi/launcher.js';
import { parseAgentConfig } from '../shared/agent-config.js';
import { parseGuardConfig } from '../shared/protocol.js';
import type { ProgressEvent } from './api.js';
import { isTestCommand, ProgressReporter } from './progress.js';

function clock() {
  const timers: (() => void)[] = [];
  const c: Clock = {
    now: () => 0,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => undefined,
  };
  return { c, fire: () => timers.splice(0).forEach((f) => f()) };
}

describe('ProgressReporter', () => {
  it('debounces progress and sends milestones at once', async () => {
    const sent: ProgressEvent[] = [];
    const { c, fire } = clock();
    const r = new ProgressReporter(async (e) => void sent.push(e), 30_000, c);
    r.report('progress', 'one');
    r.report('progress', 'two');
    expect(sent).toEqual([]);
    fire();
    expect(sent).toEqual([{ kind: 'progress', summary: 'two' }]);
    r.report('progress', 'three');
    r.report('tests', 'Checks ran and passed.');
    expect(sent.map((e) => e.summary)).toEqual(['two', 'three', 'Checks ran and passed.']);
    r.report('progress', 'four');
    r.report('done', 'finished');
    expect(sent.at(-1)).toEqual({ kind: 'done', summary: 'finished' });
    expect(sent.map((e) => e.summary)).not.toContain('four');
    r.report('done', 'x'.repeat(600));
    expect(sent.at(-1)!.summary).toHaveLength(500);
  });

  it('never throws when sending fails', () => {
    const errors: unknown[] = [];
    const r = new ProgressReporter(
      () => Promise.reject(new Error('down')),
      1,
      clock().c,
      (e) => errors.push(e),
    );
    expect(() => r.report('blocked', 'waiting')).not.toThrow();
  });
});

describe('helpers', () => {
  it('recognises test commands', () => {
    expect(isTestCommand('pnpm test')).toBe(true);
    expect(isTestCommand('npx tsc --noEmit')).toBe(true);
    expect(isTestCommand('git status')).toBe(false);
  });

  it('accepts only safe task branch names', () => {
    expect(isSafeBranch('saras/abc-fix-login')).toBe(true);
    for (const b of ['main', '-x', 'a..b', 'a b', 'x.lock', 'a/', 'a;b', 'HEAD'])
      expect(isSafeBranch(b)).toBe(false);
  });

  it('checks the Node version Pi needs', () => {
    expect(nodeVersionOk('v22.19.0')).toBe(true);
    expect(nodeVersionOk('v24.1.0\n')).toBe(true);
    expect(nodeVersionOk('v22.18.9')).toBe(false);
    expect(nodeVersionOk('v20.11.0')).toBe(false);
    expect(nodeVersionOk('')).toBe(false);
  });

  it('launches Pi locked down, with a scrubbed environment', () => {
    const spec = buildPiLaunch({
      nodePath: 'node',
      piCli: '/ext/dist/pi/bundle/cli.js',
      guardPath: '/ext/dist/guard/saras-guard.mjs',
      agentPath: '/ext/dist/agent/saras-agent.mjs',
      skillPaths: ['/ext/dist/skills/review-pr'],
      promptPaths: ['/ext/dist/prompts/review.md'],
      agent: { agentName: 'AI', router: { fast: ['f'], strong: ['s'], fallbacks: [] } },
      root: '/w',
      agentDir: '/g/pi-agent',
      sessionDir: '/g/sessions/w',
      tmpDir: '/w/.saras/tmp',
      provider: 'saras',
      model: 'auto',
      guard: {
        root: '/w',
        allowlist: [],
        autoApproveEdits: true,
        approvalTimeoutMs: 1,
        tmpDir: '/w/.saras/tmp',
        llm: { baseUrl: 'x', models: [] },
      },
      llmToken: 'llm-tok',
      mcpToken: 'mcp-tok',
      hostEnv: { PATH: '/bin', OPENROUTER_API_KEY: 'sk', HOME: '/home/me' },
    });
    expect(spec.cwd).toBe('/w');
    expect(spec.args).not.toContain('--no-session');
    expect(spec.args.join(' ')).toContain('--session-dir /g/sessions/w --continue');
    for (const flag of [
      '--no-extensions',
      '--no-approve',
      '--no-context-files',
      '--no-skills',
      '--continue',
    ]) {
      expect(spec.args).toContain(flag);
    }
    expect(
      spec.args.slice(spec.args.indexOf('--extension'), spec.args.indexOf('--extension') + 6),
    ).toEqual([
      '--extension',
      'builtin:mcp',
      '--extension',
      '/ext/dist/guard/saras-guard.mjs',
      '--extension',
      '/ext/dist/agent/saras-agent.mjs',
    ]);
    expect(spec.args.join(' ')).toContain('--skill /ext/dist/skills/review-pr');
    expect(spec.args.join(' ')).toContain('--prompt-template /ext/dist/prompts/review.md');
    expect(spec.args.slice(-4)).toEqual(['--provider', 'saras', '--model', 'auto']);
    expect(JSON.parse(spec.env.SARAS_AGENT_CONFIG ?? '{}')).toMatchObject({ agentName: 'AI' });
    expect(spec.env.OPENROUTER_API_KEY).toBeUndefined();
    expect(spec.env).toMatchObject({
      PATH: '/bin',
      PI_CODING_AGENT_DIR: '/g/pi-agent',
      SARAS_LLM_TOKEN: 'llm-tok',
      TMPDIR: '/w/.saras/tmp',
    });
    expect(spec.args.join(' ')).not.toContain('llm-tok');
    expect(spec.env.SARAS_CLAUDE_TOKEN).toBeUndefined();
  });

  it('runs on the Claude subscription: token in the env only, no Saras proxy, host keys dropped', () => {
    const spec = buildPiLaunch({
      nodePath: 'node',
      piCli: 'cli.js',
      guardPath: 'g.mjs',
      agentPath: 'a.mjs',
      skillPaths: [],
      promptPaths: [],
      agent: { agentName: 'AI', provider: 'anthropic' },
      root: '/w',
      agentDir: '/g/pi-agent',
      sessionDir: '/g/sessions/w',
      tmpDir: '/w/.saras/tmp',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      guard: {
        root: '/w',
        allowlist: [],
        autoApproveEdits: true,
        approvalTimeoutMs: 1,
        tmpDir: '/w/.saras/tmp',
      },
      llmToken: 'llm-tok',
      claudeToken: 'sk-ant-oat01-secret',
      mcpToken: 'mcp-tok',
      hostEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'sk-ant-api', ANTHROPIC_OAUTH_TOKEN: 'x' },
    });
    expect(spec.args.slice(-4)).toEqual(['--provider', 'anthropic', '--model', 'claude-opus-5-5']);
    expect(spec.env.SARAS_CLAUDE_TOKEN).toBe('sk-ant-oat01-secret');
    expect(spec.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(spec.env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(spec.args.join(' ')).not.toContain('sk-ant-oat01-secret');
    expect(parseGuardConfig(spec.env.SARAS_GUARD_CONFIG)?.llm).toBeUndefined();
    expect(parseAgentConfig(spec.env.SARAS_AGENT_CONFIG).provider).toBe('anthropic');
  });
});
