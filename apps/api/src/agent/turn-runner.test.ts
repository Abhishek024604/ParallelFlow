import type { ArenaTurnStreamEvent } from '@saras/contracts';
import { createLogger } from '@saras/observability';
import {
  type CreateSessionRequest,
  type CreateTurnRequest,
  type RuntimeClient,
  RuntimeError,
  type RuntimeEvent,
} from '@saras/runtime-client';
import { describe, expect, it } from 'vitest';
import { AiTurnLimiter, TurnBroadcaster } from './broadcaster.js';
import {
  type TurnContext,
  type TurnJob,
  type TurnOutcome,
  TurnRunner,
  type TurnStore,
} from './turn-runner.js';

const job: TurnJob = {
  turnId: 'turn-1',
  orgId: 'org-1',
  projectId: 'proj-1',
  arenaId: 'arena-1',
  messageId: 'msg-1',
  userId: 'user-1',
  text: '@AI plan the week',
};

const ctx: TurnContext = {
  agentSessionId: 'as-1',
  sessionKey: 'org/org-1/project/proj-1/arena',
  runtimeSessionId: null,
  agent: { id: 'agent-1', name: 'AI' },
  project: { name: 'Apollo', description: 'Ship it' },
  members: [{ user_id: 'user-1', display_name: 'Asha', roles: ['Owner'] }],
  author: { display_name: 'Asha', roles: ['Owner'] },
  autonomy: { answer: 'act', post: 'suggest', bogus: 'act' },
  cycle: { number: 1, stage: 'PLAN' },
};

class FakeStore implements TurnStore {
  saved: string[] = [];
  inserted: { agentId: string; text: string }[] = [];
  outcome?: TurnOutcome;
  begin = () => Promise.resolve({ ...ctx });
  saveRuntimeSession(_job: TurnJob, _as: string, id: string) {
    this.saved.push(id);
    return Promise.resolve();
  }
  insertAgentMessage(_job: TurnJob, agentId: string, text: string) {
    this.inserted.push({ agentId, text });
    return Promise.resolve('ai-msg-1');
  }
  finish(_job: TurnJob, outcome: TurnOutcome) {
    this.outcome = outcome;
    return Promise.resolve();
  }
}

const ev = (
  seq: number,
  type: RuntimeEvent['type'],
  data?: object,
  turn = 'turn-1',
): RuntimeEvent => ({
  seq,
  type,
  turn_id: turn,
  session_id: 'rs-1',
  at: '2026-10-16T00:00:00Z',
  ...(data && { data: data as Record<string, unknown> }),
});

function fakeClient(events: RuntimeEvent[], fail?: RuntimeError) {
  const calls: { sessions: CreateSessionRequest[]; turns: CreateTurnRequest[] } = {
    sessions: [],
    turns: [],
  };
  const client: RuntimeClient = {
    createSession: (req) => {
      calls.sessions.push(req);
      if (fail) return Promise.reject(fail);
      return Promise.resolve({ session_id: 'rs-1', session_key: req.session_key, status: 'ready' });
    },
    createTurn: (_id, req) => {
      calls.turns.push(req);
      return Promise.resolve({ turn_id: req.turn_id, status: 'queued' });
    },
    async *streamTurnEvents() {
      for (const e of events) yield await Promise.resolve(e);
    },
    cancelTurn: () => Promise.resolve(),
  };
  return { client, calls };
}

function setup(client: RuntimeClient | undefined) {
  const store = new FakeStore();
  const broadcaster = new TurnBroadcaster();
  const runner = new TurnRunner({
    store,
    client,
    mintToolToken: () => ({ token: 't', expires_at: 'x', mcp_url: 'http://tools/mcp' }),
    broadcaster,
    logger: createLogger({ level: 'silent' }),
  });
  const seen: ArenaTurnStreamEvent[] = [];
  broadcaster.open(job.turnId);
  broadcaster.subscribe(job.turnId, (e) => seen.push(e));
  return { store, runner, seen };
}

describe('TurnRunner', () => {
  it('opens a private chat session with the nil org, the personal agent and no arena data', async () => {
    const privateJob: TurnJob = {
      kind: 'private',
      turnId: 'turn-1',
      privateSessionId: 'ps-1',
      messageId: 'msg-1',
      userId: 'user-1',
      text: 'Draft a plan',
    };
    const { client, calls } = fakeClient([ev(1, 'turn.completed')]);
    const store = new FakeStore();
    const tokens: unknown[] = [];
    const privateRunner = new TurnRunner({
      store: Object.assign(store, {
        begin: () =>
          Promise.resolve({
            ...ctx,
            sessionKey: 'org/00000000-0000-0000-0000-000000000000/user/user-1/private/ps-1',
            project: { name: '', description: null },
            members: [],
            autonomy: {},
            cycle: null,
          }),
      }),
      client,
      mintToolToken: (input) => {
        tokens.push(input);
        return { token: 't', expires_at: 'x', mcp_url: 'http://tools/mcp' };
      },
      broadcaster: new TurnBroadcaster(),
      logger: createLogger({ level: 'silent' }),
    });
    await privateRunner.run(privateJob);

    expect(calls.sessions[0]).toEqual({
      session_key: 'org/00000000-0000-0000-0000-000000000000/user/user-1/private/ps-1',
      kind: 'private',
      scope: {
        org_id: '00000000-0000-0000-0000-000000000000',
        project_id: null,
        user_id: 'user-1',
      },
      profile: 'personal_private',
      agent: { id: 'agent-1', kind: 'personal', display_name: 'AI', on_behalf_of: 'user-1' },
      context_seed: {},
      tool_token: { token: 't', expires_at: 'x', mcp_url: 'http://tools/mcp' },
    });
    expect(tokens).toEqual([
      expect.objectContaining({
        orgId: '00000000-0000-0000-0000-000000000000',
        projectId: null,
        principal: { type: 'agent', id: 'agent-1', kind: 'personal', on_behalf_of: 'user-1' },
        scopes: ['private.save_artifact', 'knowledge.search'],
      }),
    ]);
    expect(store.outcome).toMatchObject({ status: 'completed' });
  });

  it('maps events to live text, the AI message and the completed outcome', async () => {
    const { client, calls } = fakeClient([
      ev(1, 'turn.started'),
      ev(2, 'message.delta', { text: 'Hi ' }),
      ev(3, 'message.delta', { text: 'there' }, 'other-turn'),
      ev(4, 'message.delta', { text: 'team' }),
      ev(5, 'message.completed', { text: 'Hi team' }),
      ev(6, 'turn.completed', { usage: { output_tokens: 3 } }),
    ]);
    const { store, runner, seen } = setup(client);
    await runner.run(job);

    expect(calls.sessions[0]).toMatchObject({
      session_key: ctx.sessionKey,
      kind: 'arena',
      profile: 'central_arena',
      scope: { org_id: 'org-1', project_id: 'proj-1' },
      agent: { id: 'agent-1', kind: 'central', display_name: 'AI' },
      context_seed: { project_brief: 'Apollo\n\nShip it', members: ctx.members },
    });
    expect(store.saved).toEqual(['rs-1']);
    expect(calls.turns[0]).toMatchObject({
      turn_id: 'turn-1',
      mode: 'prompt',
      input: { text: job.text, message_id: 'msg-1', author: { type: 'user', id: 'user-1' } },
      autonomy: { answer: 'act', post: 'suggest' },
      reply_expected: true,
      app_state: { cycle_number: 1, stage: 'PLAN' },
    });
    expect(calls.turns[0]?.autonomy).not.toHaveProperty('bogus');
    expect(store.inserted).toEqual([{ agentId: 'agent-1', text: 'Hi team' }]);
    expect(store.outcome).toEqual({
      status: 'completed',
      failureCode: null,
      usage: { output_tokens: 3 },
    });
    expect(seen).toEqual([
      { type: 'delta', text: 'Hi ' },
      { type: 'delta', text: 'team' },
      { type: 'status', status: 'completed', failure_code: null, message_id: 'ai-msg-1' },
    ]);
  });

  it('turn.failed and turn.cancelled set the status and failure code', async () => {
    for (const [type, data, expected] of [
      ['turn.failed', { error: { code: 'BUDGET_EXCEEDED' } }, 'BUDGET_EXCEEDED'],
      ['turn.cancelled', undefined, 'CANCELLED'],
    ] as const) {
      const { client } = fakeClient([ev(1, type, data)]);
      const { store, runner } = setup(client);
      await runner.run(job);
      expect(store.outcome?.failureCode).toBe(expected);
      expect(store.inserted).toEqual([]);
    }
  });

  it('fails fast without a runtime, and maps an unreachable runtime', async () => {
    const none = setup(undefined);
    await none.runner.run(job);
    expect(none.store.outcome).toEqual({ status: 'failed', failureCode: 'RUNTIME_NOT_CONFIGURED' });
    expect(none.seen.at(-1)).toMatchObject({
      type: 'status',
      failure_code: 'RUNTIME_NOT_CONFIGURED',
    });

    const { client } = fakeClient([], new RuntimeError('NETWORK', 0, true));
    const down = setup(client);
    await down.runner.run(job);
    expect(down.store.outcome?.failureCode).toBe('RUNTIME_UNREACHABLE');
  });
});

describe('AiTurnLimiter', () => {
  it('allows 30 per minute per user', () => {
    let now = 0;
    const limiter = new AiTurnLimiter(30, 60_000, () => now);
    for (let i = 0; i < 30; i++) expect(limiter.tryTake('u')).toBe(true);
    expect(limiter.tryTake('u')).toBe(false);
    expect(limiter.tryTake('v')).toBe(true);
    now = 60_001;
    expect(limiter.tryTake('u')).toBe(true);
  });
});
