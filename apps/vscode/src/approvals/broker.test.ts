import { describe, expect, it } from 'vitest';
import type { UiResponse } from '../pi/rpc.js';
import { decodeDecision, decodeQuestionAnswer, encodeRequest } from '../shared/protocol.js';
import { ApprovalBroker, type Clock } from './broker.js';
import { handleUiRequest } from './ui-bridge.js';

function fakeClock() {
  let now = 1000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(id);
        t.fn();
      }
    }
  };
  return { clock, advance, pending: () => timers.size };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('ApprovalBroker', () => {
  it('resolves once with the answer and clears the timer', async () => {
    const { clock, pending } = fakeClock();
    const broker = new ApprovalBroker(clock);
    const changes: number[] = [];
    broker.onChange((open) => changes.push(open.length));
    const p = broker.request({ id: 'a', kind: 'command', title: 't', detail: 'npm i' }, 5000);
    expect(broker.open).toHaveLength(1);
    expect(broker.answer('a', { decision: 'approve' })).toBe(true);
    expect(broker.answer('a', { decision: 'deny' })).toBe(false);
    await expect(p).resolves.toEqual({ decision: 'approve' });
    expect(pending()).toBe(0);
    expect(changes).toEqual([1, 0]);
  });

  it('denies on timeout and ignores a late answer', async () => {
    const { clock, advance } = fakeClock();
    const broker = new ApprovalBroker(clock);
    const p = broker.request({ id: 'a', kind: 'command', title: 't', detail: 'x' }, 5000);
    advance(4999);
    expect(broker.open).toHaveLength(1);
    advance(1);
    await expect(p).resolves.toEqual({ cancelled: true, reason: 'No answer in time' });
    expect(broker.answer('a', { decision: 'approve' })).toBe(false);
  });

  it('cancelAll denies everything open', async () => {
    const broker = new ApprovalBroker(fakeClock().clock);
    const a = broker.request({ id: 'a', kind: 'edit', title: 't', detail: 'x' }, 5000);
    const b = broker.request({ id: 'b', kind: 'question', title: 't', detail: 'q' }, 5000);
    broker.cancelAll('stopped');
    await expect(a).resolves.toMatchObject({ cancelled: true });
    await expect(b).resolves.toMatchObject({ cancelled: true });
  });
});

describe('handleUiRequest (approval flow)', () => {
  function setup() {
    const { clock, advance } = fakeClock();
    const broker = new ApprovalBroker(clock);
    const responses: [string, UiResponse][] = [];
    const notices: string[] = [];
    const deps = {
      broker,
      timeoutMs: 60_000,
      respond: (id: string, r: UiResponse) => responses.push([id, r]),
      notify: (_l: string, m: string) => notices.push(m),
    };
    return { broker, responses, notices, deps, advance };
  }

  const commandTitle = encodeRequest({
    kind: 'command',
    command: 'npm install',
    cwd: '/w',
    reason: 'Not on the allowlist',
  });

  it('approve: the guard decodes approve', async () => {
    const { broker, responses, deps } = setup();
    const done = handleUiRequest(
      {
        type: 'extension_ui_request',
        id: 'u1',
        method: 'select',
        title: commandTitle,
        timeout: 300_000,
      },
      deps,
    );
    expect(broker.open[0]).toMatchObject({ kind: 'command', detail: 'npm install', cwd: '/w' });
    broker.answer('u1', { decision: 'approve_session' });
    await done;
    const value = (responses[0]![1] as { value: string }).value;
    expect(decodeDecision(value)).toEqual({ decision: 'approve_session' });
  });

  it('deny with reason reaches the guard', async () => {
    const { broker, responses, deps } = setup();
    const done = handleUiRequest(
      { type: 'extension_ui_request', id: 'u1', method: 'select', title: commandTitle },
      deps,
    );
    broker.answer('u1', { decision: 'deny', reason: 'use pnpm' });
    await done;
    expect(decodeDecision((responses[0]![1] as { value: string }).value)).toEqual({
      decision: 'deny',
      reason: 'use pnpm',
    });
  });

  it('timeout: cancelled, which the guard reads as a denial', async () => {
    const { responses, deps, advance } = setup();
    const done = handleUiRequest(
      {
        type: 'extension_ui_request',
        id: 'u1',
        method: 'select',
        title: commandTitle,
        timeout: 10_000,
      },
      deps,
    );
    await tick();
    advance(9_000); // answers a second before Pi's own timeout
    await done;
    expect(responses[0]).toEqual(['u1', { cancelled: true }]);
    expect(decodeDecision(undefined).decision).toBe('deny');
  });

  it('questions return the chosen answer; plain selects return the raw option', async () => {
    const { broker, responses, deps } = setup();
    const q = handleUiRequest(
      {
        type: 'extension_ui_request',
        id: 'q1',
        method: 'select',
        title: encodeRequest({
          kind: 'question',
          question: 'Which DB?',
          options: ['pg', 'sqlite'],
        }),
      },
      deps,
    );
    expect(broker.open[0]).toMatchObject({
      kind: 'question',
      detail: 'Which DB?',
      options: ['pg', 'sqlite'],
    });
    broker.answer('q1', { answer: 'pg' });
    await q;
    expect(decodeQuestionAnswer((responses[0]![1] as { value: string }).value)).toBe('pg');

    const plain = handleUiRequest(
      {
        type: 'extension_ui_request',
        id: 'p1',
        method: 'select',
        title: 'Pick',
        options: ['a', 'b'],
      },
      deps,
    );
    broker.answer('p1', { answer: 'b' });
    await plain;
    expect(responses[1]).toEqual(['p1', { value: 'b' }]);
  });

  it('confirm maps to confirmed true/false; notify is passed through', async () => {
    const { broker, responses, notices, deps } = setup();
    const c = handleUiRequest(
      { type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Sure?', message: 'x' },
      deps,
    );
    broker.answer('c1', { decision: 'deny' });
    await c;
    expect(responses[0]).toEqual(['c1', { confirmed: false }]);
    await handleUiRequest(
      { type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hello' },
      deps,
    );
    expect(notices).toEqual(['hello']);
  });
});
