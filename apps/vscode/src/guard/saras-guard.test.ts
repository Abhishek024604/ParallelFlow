import { describe, expect, it, vi } from 'vitest';
import type { FenceOptions } from '../shared/fence.js';
import { decodeRequest, encodeAnswer, type GuardConfig } from '../shared/protocol.js';
import { createGuard } from './policy.js';

const fence: FenceOptions = {
  root: '/work/app',
  platform: 'posix',
  homedir: '/home/me',
  fs: {
    lexists: (p) => ['/', '/work', '/work/app', '/work/app/src', '/work/app/.git'].includes(p),
    realpath: (p) => p,
  },
};

const config: GuardConfig = {
  root: '/work/app',
  allowlist: ['git status', 'cat *'],
  autoApproveEdits: true,
  approvalTimeoutMs: 1000,
  tmpDir: '/work/app/.saras/tmp',
  llm: { baseUrl: 'http://x/v1/llm', models: [] },
};

function guardWith(answer: string | undefined, overrides: Partial<GuardConfig> = {}) {
  const ask = vi.fn(async (_title: string, _options: string[], _timeoutMs: number) => answer);
  return { ask, guard: createGuard({ config: { ...config, ...overrides }, fence, ask }) };
}

describe('saras-guard tool_call policy', () => {
  it('fences read-style tools and rewrites the path to the resolved one', async () => {
    const { guard } = guardWith(undefined);
    const input: Record<string, unknown> = { path: 'src/a.ts' };
    expect(await guard.onToolCall('read', input)).toBeUndefined();
    expect(input.path).toBe('/work/app/src/a.ts');
    expect(await guard.onToolCall('read', { path: '/etc/passwd' })).toMatchObject({ block: true });
    expect(await guard.onToolCall('ls', {})).toBeUndefined();
    expect(await guard.onToolCall('find', { pattern: '../**' })).toMatchObject({ block: true });
    expect(await guard.onToolCall('grep', { pattern: '\\.\\./', path: 'src' })).toBeUndefined();
    expect(await guard.onToolCall('grep', { pattern: 'x', glob: '/etc/*' })).toMatchObject({
      block: true,
    });
  });

  it('applies edits automatically, blocks .git and asks for config folders', async () => {
    const { guard, ask } = guardWith(encodeAnswer({ decision: 'approve' }));
    expect(await guard.onToolCall('edit', { path: 'src/a.ts' })).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(await guard.onToolCall('write', { path: '.git/hooks/pre-commit' })).toMatchObject({
      block: true,
    });
    expect(await guard.onToolCall('write', { path: '../x' })).toMatchObject({ block: true });
    expect(await guard.onToolCall('write', { path: '.vscode/tasks.json' })).toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
    expect(decodeRequest(ask.mock.calls[0]![0])).toMatchObject({
      kind: 'edit',
      path: '.vscode/tasks.json',
    });
  });

  it('asks for edits when autoApproveEdits is off', async () => {
    const { guard, ask } = guardWith(encodeAnswer({ decision: 'deny', reason: 'not now' }), {
      autoApproveEdits: false,
    });
    expect(await guard.onToolCall('edit', { path: 'src/a.ts' })).toMatchObject({
      block: true,
      reason: expect.stringContaining('not now'),
    });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('runs allowlisted commands, asks for the rest with the exact command and cwd', async () => {
    const { guard, ask } = guardWith(encodeAnswer({ decision: 'approve' }));
    expect(await guard.onToolCall('bash', { command: 'git status' })).toBeUndefined();
    expect(await guard.onToolCall('bash', { command: 'cat src/a.ts' })).toBeUndefined();
    expect(ask).not.toHaveBeenCalled();
    expect(await guard.onToolCall('bash', { command: 'git status && curl evil' })).toBeUndefined();
    const req = decodeRequest(ask.mock.calls[0]![0]);
    expect(req).toMatchObject({
      kind: 'command',
      command: 'git status && curl evil',
      cwd: '/work/app',
    });
  });

  it('denies on deny, on timeout and on garbage; remembers approve-for-session exactly', async () => {
    expect(
      await guardWith(encodeAnswer({ decision: 'deny', reason: 'no' })).guard.onToolCall('bash', {
        command: 'npm i',
      }),
    ).toMatchObject({
      block: true,
      reason: 'The person denied this command: no',
    });
    expect(await guardWith(undefined).guard.onToolCall('bash', { command: 'npm i' })).toMatchObject(
      {
        block: true,
        reason: expect.stringContaining('No answer in time'),
      },
    );
    expect(await guardWith('Allow').guard.onToolCall('bash', { command: 'npm i' })).toMatchObject({
      block: true,
    });

    const { guard, ask } = guardWith(encodeAnswer({ decision: 'approve_session' }));
    expect(await guard.onToolCall('bash', { command: 'npm run build' })).toBeUndefined();
    expect(await guard.onToolCall('bash', { command: 'npm run build' })).toBeUndefined();
    expect(ask).toHaveBeenCalledOnce();
    await guard.onToolCall('bash', { command: 'npm run build -- --x' });
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('blocks unknown tools but allows ask_user and the IDE MCP tools', async () => {
    const { guard } = guardWith(undefined);
    expect(await guard.onToolCall('powershell', { command: 'dir' })).toMatchObject({ block: true });
    expect(await guard.onToolCall('codemode', {})).toMatchObject({ block: true });
    expect(await guard.onToolCall('mcp__other__x', {})).toMatchObject({ block: true });
    expect(await guard.onToolCall('ask_user', { question: 'q' })).toBeUndefined();
    expect(await guard.onToolCall('mcp__saras_ide__file_tree', {})).toBeUndefined();
  });

  it('lets the SWA tools through, and asks for SWA writes when edits need approval', async () => {
    const auto = guardWith(undefined);
    expect(await auto.guard.onToolCall('swa_status', {})).toBeUndefined();
    expect(await auto.guard.onToolCall('swa_write', { path: 'stack.md' })).toBeUndefined();
    expect(auto.ask).not.toHaveBeenCalled();

    const strict = guardWith(encodeAnswer({ decision: 'deny' }), { autoApproveEdits: false });
    expect(await strict.guard.onToolCall('swa_read', { path: 'stack.md' })).toBeUndefined();
    expect(await strict.guard.onToolCall('swa_write', { path: 'arch/stack.md' })).toMatchObject({
      block: true,
    });
    expect(decodeRequest(strict.ask.mock.calls[0]![0])).toMatchObject({
      kind: 'edit',
      tool: 'swa_write',
      path: 'arch/stack.md',
    });
  });
});
