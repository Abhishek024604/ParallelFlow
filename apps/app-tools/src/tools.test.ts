import { randomUUID } from 'node:crypto';
import type { Logger } from '@parallelflow/observability';
import { mintToolToken, type ToolTokenInput } from '@parallelflow/runtime-client';
import { describe, expect, it, vi } from 'vitest';
import { loadContract } from './contract.js';
import {
  assertNoHumanOnly,
  decideAutonomy,
  HUMAN_ONLY_TOOLS,
  listableTools,
  NOT_AVAILABLE_YET,
} from './policy.js';
import { NIL_UUID, type ToolPrincipal, ToolTokenError, verifyToolToken } from './token.js';
import { type Args, argsHash, type CallAudit, executeTool, type ToolBackend } from './tools.js';

const KEY = 'k'.repeat(40);
const contract = loadContract();
const specs = new Map(contract.tools.map((t) => [t.name, t]));
const ALL = contract.tools.map((t) => t.name);

const org = randomUUID();
const project = randomUUID();
const user = randomUUID();
const chat = randomUUID();

const central: ToolTokenInput = {
  sessionKey: `org/${org}/project/${project}/arena`,
  orgId: org,
  projectId: project,
  principal: { type: 'agent', id: randomUUID(), kind: 'central' },
  scopes: ALL,
};
const personal: ToolTokenInput = {
  sessionKey: `org/${NIL_UUID}/user/${user}/private/${chat}`,
  orgId: NIL_UUID,
  projectId: null,
  principal: { type: 'agent', id: randomUUID(), kind: 'personal', on_behalf_of: user },
  scopes: ['private.save_artifact', 'knowledge.search', 'artifacts.read', 'files.read'],
};

const tokenOf = (input: ToolTokenInput, nowMs = Date.now()) =>
  mintToolToken(input, KEY, 'http://localhost:4200/mcp', nowMs).token;
const principal = (input: ToolTokenInput) => verifyToolToken(tokenOf(input), KEY);

function fakeBackend(overrides: Partial<ToolBackend> = {}): ToolBackend & { audits: CallAudit[] } {
  const audits: CallAudit[] = [];
  return {
    audits,
    autonomy: async () => 'act',
    isProjectMember: async () => true,
    turnBelongsToSession: async () => true,
    readHistory: async () => [{ text: 'hello' }],
    projectOverview: async () => ({ name: 'P' }),
    listMembers: async () => [],
    cycleState: async () => null,
    listArtifacts: async () => [],
    readArtifact: async () => null,
    search: async () => [],
    recall: async () => [],
    arenaFile: async () => ({
      status: 'not_available',
      reason: 'This chat is not linked to an arena.',
    }),
    listFiles: async () => [],
    readFile: async () => null,
    listPrivateArtifacts: async () => [],
    readPrivateArtifact: async () => null,
    requestGate: async () => ({ status: 'requested', approval_id: 'a1' }),
    logCall: async (_p, audit) => {
      audits.push(audit);
    },
    ...overrides,
  };
}

function fakeLogger(): Logger & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const log = (...args: unknown[]) => calls.push(args);
  return { calls, info: log, warn: log, error: log, debug: log } as unknown as Logger & {
    calls: unknown[][];
  };
}

const run = (
  p: ToolPrincipal,
  name: string,
  args: Args,
  backend = fakeBackend(),
  logger = fakeLogger(),
) => executeTool({ specs, backend, logger }, p, name, args, randomUUID());

describe('tool token verification', () => {
  it('accepts a valid central and personal token', () => {
    const c = principal(central);
    expect(c).toMatchObject({ kind: 'central', orgId: org, projectId: project, isPrivate: false });
    expect(c.privateSessionId).toBeNull();
    const p = principal(personal);
    expect(p).toMatchObject({
      kind: 'personal',
      onBehalfOf: user,
      isPrivate: true,
      projectId: null,
      privateSessionId: chat,
    });
  });

  it('rejects a bad signature, an expired token and a wrong audience', () => {
    expect(() => verifyToolToken(tokenOf(central), 'x'.repeat(40))).toThrow(ToolTokenError);
    const old = tokenOf(central, Date.now() - 2 * 60 * 60 * 1000);
    expect(() => verifyToolToken(old, KEY)).toThrow(ToolTokenError);
    expect(() => verifyToolToken('a.b.c', KEY)).toThrow(ToolTokenError);
  });

  it('rejects a central token whose session key names another project', () => {
    const other = { ...central, sessionKey: `org/${org}/project/${randomUUID()}/arena` };
    expect(() => principal(other)).toThrow(ToolTokenError);
  });

  it('rejects a personal token acting for a user other than the session owner', () => {
    const other = {
      ...personal,
      principal: { ...personal.principal, on_behalf_of: randomUUID() },
    };
    expect(() => principal(other)).toThrow(ToolTokenError);
  });
});

describe('scope', () => {
  it('returns SCOPE_MISMATCH for an artifact outside the token project', async () => {
    const result = await run(principal(central), 'artifacts.read', { artifact_id: randomUUID() });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: 'SCOPE_MISMATCH', message: expect.any(String) },
    });
  });

  it('does not let an unbound personal agent read arena tools', async () => {
    const result = await run(principal(personal), 'artifacts.read', {
      artifact_id: randomUUID(),
    });
    expect(result.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('lists only tools allowed for the agent kind, the token scopes and implemented', () => {
    const c = listableTools(contract.tools, principal(central)).map((t) => t.name);
    expect(c).toContain('arena.read_history');
    expect(c).toContain('artifacts.create_draft');
    expect(c).not.toContain('private.save_artifact');
    for (const name of NOT_AVAILABLE_YET) expect(c).not.toContain(name);
    const p = listableTools(contract.tools, principal(personal)).map((t) => t.name);
    expect(p.sort()).toEqual(['files.read', 'knowledge.search', 'private.save_artifact']);
  });

  it('arena.file: a private chat token may open a linked arena file; the central agent may not', async () => {
    const linked = principal({ ...personal, scopes: ['arena.file'] });
    expect(listableTools(contract.tools, linked).map((t) => t.name)).toEqual(['arena.file']);
    const seen: { file: string; chat: string | null }[] = [];
    const backend = fakeBackend({
      arenaFile: async (pp, args) => {
        seen.push({ file: args.file, chat: pp.privateSessionId });
        return { status: 'ok', key: 'F-3', name: 'spec.md', content: '# Spec', truncated: false };
      },
    });
    const result = await run(linked, 'arena.file', { file: 'F-3' }, backend);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ status: 'ok', key: 'F-3' });
    expect(seen).toEqual([{ file: 'F-3', chat }]);
    // No link: a plain answer, not an error.
    const none = await run(linked, 'arena.file', { file: 'F-1' });
    expect(none.structuredContent).toMatchObject({ status: 'not_available' });
    // Read-only and personal only.
    expect(specs.get('arena.file')?.['x-parallelflow']).toMatchObject({
      side_effect: 'read',
      allowed_agents: ['personal'],
    });
    const c = await run(principal(central), 'arena.file', { file: 'F-1' });
    expect(c.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(run(linked, 'arena.file', {})).rejects.toThrow('args.file is required');
  });

  it('memory.recall: offered to a linked private chat token; no link answers not_available', async () => {
    const linked = principal({ ...personal, scopes: ['memory.recall'] });
    expect(listableTools(contract.tools, linked).map((t) => t.name)).toEqual(['memory.recall']);
    expect(specs.get('memory.recall')?.['x-parallelflow']).toMatchObject({
      side_effect: 'read',
      allowed_agents: ['central', 'personal'],
    });
    const seen: (string | null)[] = [];
    const found = fakeBackend({
      recall: async (pp) => {
        seen.push(pp.privateSessionId);
        return [{ key: 'D-001' }];
      },
    });
    const ok = await run(linked, 'memory.recall', { query: 'D-001' }, found);
    expect(ok.structuredContent).toEqual({ memory: [{ key: 'D-001' }] });
    expect(seen).toEqual([chat]);
    const none = fakeBackend({
      recall: async () => ({
        status: 'not_available',
        reason: 'This chat is not linked to an arena.',
      }),
    });
    const result = await run(linked, 'memory.recall', { query: 'D-001' }, none);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      status: 'not_available',
      reason: 'This chat is not linked to an arena.',
    });
    // The central agent keeps its arena's memory.
    const c = await run(principal(central), 'memory.recall', { query: 'D-001' });
    expect(c.structuredContent).toEqual({ memory: [] });
  });

  it('refuses a tool missing from the token scopes', async () => {
    const narrow = principal({ ...central, scopes: ['arena.read_history'] });
    const result = await run(narrow, 'members.list', {});
    expect(result.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('autonomy', () => {
  it('decides by level and side effect', () => {
    expect(decideAutonomy('read', 'off')).toEqual({ kind: 'deny', code: 'FORBIDDEN' });
    expect(decideAutonomy('write', 'off')).toEqual({ kind: 'deny', code: 'FORBIDDEN' });
    expect(decideAutonomy('read', 'approve')).toEqual({ kind: 'allow' });
    expect(decideAutonomy('write', 'approve')).toEqual({ kind: 'deny', code: 'APPROVAL_REQUIRED' });
    expect(decideAutonomy('write', 'suggest')).toEqual({ kind: 'draft_only' });
    expect(decideAutonomy('write', 'act')).toEqual({ kind: 'allow' });
  });

  it('applies the arena policy to a tool call', async () => {
    const p = principal(central);
    const args = { name: 'requirements.md', kind: 'spec', content: '# Spec' };
    const level = (l: 'off' | 'suggest' | 'approve' | 'act') =>
      fakeBackend({ autonomy: async () => l });
    expect(
      (await run(p, 'artifacts.create_draft', args, level('off'))).structuredContent,
    ).toMatchObject({ error: { code: 'FORBIDDEN' } });
    const approve = level('approve');
    expect((await run(p, 'artifacts.create_draft', args, approve)).structuredContent).toMatchObject(
      {
        error: { code: 'APPROVAL_REQUIRED' },
      },
    );
    expect(approve.audits[0]).toMatchObject({ outcome: 'approval_required' });
    expect((await run(p, 'artifacts.create_draft', args, level('suggest'))).isError).toBe(false);
    expect(
      (await run(p, 'artifacts.create_draft', args, level('act'))).structuredContent,
    ).toMatchObject({
      status: 'accepted',
      delivery: 'artifact.proposed',
    });
    expect((await run(p, 'arena.read_history', {}, level('off'))).isError).toBe(true);
    // A name the app cannot store is refused here, not accepted and then lost.
    await expect(
      run(p, 'artifacts.create_draft', { ...args, name: 'arch/stack.md' }, level('act')),
    ).rejects.toThrow('slashes');
    // ADR-038: arena files have standard names; the AI is told the rule so it can retry.
    await expect(
      run(p, 'artifacts.create_draft', { ...args, name: 'Spec' }, level('act')),
    ).rejects.toThrow('standard name');
  });

  it('stage.request_gate follows the request_gate autonomy class', async () => {
    const p = principal(central);
    const args = { summary: 'Goal and spec are ready' };
    const level = (l: 'off' | 'suggest' | 'approve' | 'act') =>
      fakeBackend({ autonomy: async () => l });
    expect((await run(p, 'stage.request_gate', args, level('approve'))).structuredContent).toEqual({
      error: { code: 'APPROVAL_REQUIRED', message: 'A teammate must approve this first' },
    });
    expect((await run(p, 'stage.request_gate', args, level('act'))).structuredContent).toEqual({
      status: 'requested',
      approval_id: 'a1',
    });
  });

  it('answers "not available yet" for tools without a feature', async () => {
    const result = await run(principal(central), 'tasks.list', {});
    expect(result.structuredContent).toEqual({
      error: { code: 'FORBIDDEN', message: 'not available yet' },
    });
  });
});

describe('human-only actions', () => {
  it('are never in the contract', () => {
    expect(() => assertNoHumanOnly(contract.tools)).not.toThrow();
    for (const name of HUMAN_ONLY_TOOLS) expect(specs.has(name)).toBe(false);
  });

  it('would stop the server if the contract added one', () => {
    const leaked = { ...contract.tools[0]!, name: 'stage.approve' };
    expect(() => assertNoHumanOnly([leaked])).toThrow(/Human-only/);
  });

  it('cannot be called even with a forged scope', async () => {
    const forged = principal({ ...central, scopes: [...ALL, 'stage.approve'] });
    const result = await run(forged, 'stage.approve', {});
    expect(result.structuredContent).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('audit and logs', () => {
  it('stores a hash of the arguments and never logs them', async () => {
    const backend = fakeBackend();
    const logger = fakeLogger();
    const secret = 'canary-arg-7f3a';
    await run(principal(central), 'knowledge.search', { query: secret }, backend, logger);
    expect(backend.audits).toHaveLength(1);
    expect(backend.audits[0]!.argsHash).toBe(argsHash({ query: secret }));
    expect(JSON.stringify(backend.audits)).not.toContain(secret);
    expect(JSON.stringify(logger.calls)).not.toContain(secret);
  });

  it('rejects invalid arguments as a protocol error and audits it', async () => {
    const backend = fakeBackend();
    await expect(
      run(principal(central), 'arena.read_history', { project_id: randomUUID() }, backend),
    ).rejects.toThrow(/not allowed/);
    expect(backend.audits[0]).toMatchObject({ outcome: 'error', denyCode: 'INVALID_INPUT' });
  });

  it('keeps a failing audit write from failing the call', async () => {
    const backend = fakeBackend({ logCall: vi.fn().mockRejectedValue(new Error('db down')) });
    const result = await run(principal(central), 'members.list', {}, backend);
    expect(result.isError).toBe(false);
  });
});

describe('files', () => {
  it('reads a file of the token, and denies any other id', async () => {
    const p = principal(personal);
    const file = { file_id: randomUUID(), name: 'notes.md', readable: true, content: '# Notes' };
    const ok = await run(
      p,
      'files.read',
      { file_id: file.file_id },
      fakeBackend({
        readFile: async () => file,
      }),
    );
    expect(ok.structuredContent).toMatchObject({ file: { name: 'notes.md' } });
    const other = await run(p, 'files.read', { file_id: randomUUID() });
    expect(other.structuredContent).toMatchObject({ error: { code: 'SCOPE_MISMATCH' } });
    // Not in the token's scopes.
    const listed = await run(p, 'files.list', {});
    expect(listed.structuredContent).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });
});

describe('ask.question', () => {
  it('accepts a valid question for both agents and delivers it as question.asked', async () => {
    const args = {
      question: 'Which database?',
      options: ['Postgres', 'SQLite'],
      allow_other: true,
    };
    for (const p of [principal(central), principal({ ...personal, scopes: ['ask.question'] })]) {
      expect((await run(p, 'ask.question', args)).structuredContent).toMatchObject({
        status: 'accepted',
        delivery: 'question.asked',
        options: ['Postgres', 'SQLite'],
        allow_other: true,
      });
    }
  });

  it('rejects a question with one option', async () => {
    await expect(
      run(principal(central), 'ask.question', { question: 'Which?', options: ['Only'] }),
    ).rejects.toThrow(/options/);
  });
});
