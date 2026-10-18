import { randomUUID } from 'node:crypto';
import type { Logger } from '@saras/observability';
import { mintToolToken, type ToolTokenInput } from '@saras/runtime-client';
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
    const p = principal(personal);
    expect(p).toMatchObject({
      kind: 'personal',
      onBehalfOf: user,
      isPrivate: true,
      projectId: null,
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
    const args = { name: 'Spec', kind: 'spec', content: '# Spec' };
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
