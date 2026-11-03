import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { AskedQuestion, ParallelFlowTurnContext } from '@parallelflow/pi-parallelflow';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentTool, CreateAgentOptions, HarnessEvent } from './agent.js';
import { PiEngine } from './pi-engine.js';

// The real Pi harness with the ParallelFlow extension, on Pi's faux provider: no network, no model, no
// shell. Checks what only a real Pi session shows: the extension's sections reach the model, the
// virtual model routes to a physical one, message_end cleaning lands in the session file, the
// autonomy hook blocks before the tool runs, ask_user ends the turn, and an ephemeral fork reads the
// parent's history without writing to it.

const UUID = '0190f0aa-1111-7222-8333-444455556666';
const root = mkdtempSync(join(tmpdir(), 'parallelflow-pi-engine-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const faux = fauxProvider({
  provider: 'faux',
  models: [
    { id: 'fast', contextWindow: 100_000, maxTokens: 4_000 },
    { id: 'strong', contextWindow: 100_000, maxTokens: 4_000, reasoning: true },
  ],
});
const seen: { model: string; system: string; texts: string[] }[] = [];
const record = (context: TranscriptContext, model: string) => {
  seen.push({
    model,
    system: getCurrentSystemPrompt(context.messages),
    texts: context.messages.map((m) => JSON.stringify(m.content ?? '')),
  });
};

const engine = new PiEngine({
  apiKey: 'faux-key',
  routing: { fast: ['fast'], strong: ['strong'], fallbacks: [] },
  dataDir: join(root, 'data'),
  provider: 'faux',
  prepareRuntime: (runtime) => runtime.registerNativeProvider(faux.provider),
});
await engine.init();

function options(
  name: string,
  extra: Partial<CreateAgentOptions> & { turn?: ParallelFlowTurnContext } = {},
): CreateAgentOptions & { questions: AskedQuestion[] } {
  const questions: AskedQuestion[] = [];
  const dir = join(root, name);
  return {
    sessionDir: join(dir, 'pi'),
    cwd: join(dir, 'workspace'),
    agentDir: join(dir, 'agent'),
    session: { profile: 'central_arena', agentName: 'AI', arenaBrief: 'Build a todo app' },
    turnContext: () => extra.turn,
    onQuestion: (q) => questions.push(q),
    tools: [],
    questions,
    ...extra,
  };
}

const collect = (events: HarnessEvent[]) => (event: HarnessEvent) => events.push(event);
const sessionFile = (dir: string) => {
  const file = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))[0];
  return file ? readFileSync(join(dir, file), 'utf8') : '';
};

// Pi needs Node >= 22.19; on an older Node the engine is unavailable by design (pi-engine.ts).
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const piNode = major > 22 || (major === 22 && minor >= 19);

describe.skipIf(!piNode)('Pi engine with the ParallelFlow extension (faux provider)', () => {
  it('is available on the faux provider', () => {
    expect(engine.unavailableReason()).toBeNull();
  });

  it('routes, injects sections, and stores the cleaned message', async () => {
    const opts = options('arena', { turn: { cycle: { number: 2, stage: 'DESIGN' } } });
    const handle = await engine.create(opts);
    faux.setResponses([
      (context, _o, _s, model) => {
        record(context, model.id);
        return fauxAssistantMessage(`Hi! See plan.md (ID: ${UUID}).`);
      },
    ]);
    const events: HarnessEvent[] = [];
    handle.subscribe(collect(events));
    await handle.prompt('<message from="Riya">\nhi there\n</message>');
    const call = seen.at(-1)!;
    expect(call.model).toBe('fast');
    expect(call.system).toContain('You are AI, the AI teammate');
    expect(call.system).toContain('Cycle 2, stage DESIGN');
    expect(call.system).toContain('Build a todo app');
    const end = events.filter((e) => e.type === 'message_end').at(-1) as unknown as {
      message: { content: { type: string; text?: string }[]; model?: string };
    };
    expect(end.message.content[0]?.text).toBe('Hi! See plan.md.');
    expect(end.message.model).toBe('fast');
    expect(sessionFile(opts.sessionDir)).not.toContain(UUID);
    handle.dispose();
  });

  it('expands a slash command and routes it to the strong model', async () => {
    const opts = options('command', { turn: { job: 'document' } });
    const handle = await engine.create(opts);
    faux.setResponses([
      (context, _o, _s, model) => {
        record(context, model.id);
        return fauxAssistantMessage('Created checkout-spec.md (draft)');
      },
    ]);
    await handle.prompt('/spec checkout flow', { expand: true });
    const call = seen.at(-1)!;
    expect(call.model).toBe('strong');
    expect(call.texts.join(' ')).toContain('Write a spec for: checkout flow');
    expect(call.system).toContain('write-spec');
    handle.dispose();
  });

  it('blocks a forbidden tool in tool_call, and ask_user ends the turn with a question', async () => {
    let ran = 0;
    const post: AgentTool = {
      name: 'arena_post_message',
      description: 'Post',
      parameters: { type: 'object', properties: { body: { type: 'string' } } },
      execute: async () => {
        ran += 1;
        return 'posted';
      },
    };
    const opts = options('tools', { tools: [post], turn: { autonomy: { post: 'off' } } });
    const handle = await engine.create(opts);
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('arena_post_message', { body: 'hello' })),
      fauxAssistantMessage(
        fauxToolCall('ask_user', { question: 'Which audience?', options: ['Team', 'Customers'] }),
      ),
      fauxAssistantMessage('should not be asked for'),
    ]);
    const events: HarnessEvent[] = [];
    handle.subscribe(collect(events));
    await handle.prompt('post hello, then ask me');
    expect(ran).toBe(0);
    const blocked = events.find(
      (e) => e.type === 'tool_execution_end' && e['toolName'] === 'arena_post_message',
    );
    expect(blocked?.['isError']).toBe(true);
    expect(opts.questions).toEqual([
      { question: 'Which audience?', options: ['Team', 'Customers'], allow_other: false },
    ]);
    expect(faux.getPendingResponseCount()).toBe(1); // the turn ended after ask_user
    handle.dispose();
  });

  it('runs an ephemeral fork on a copy of the history without touching the parent file', async () => {
    const opts = options('parent');
    const parent = await engine.create(opts);
    faux.setResponses([fauxAssistantMessage('Noted: we use Postgres.')]);
    await parent.prompt('Decision: we use Postgres (canary-db-42).');
    parent.dispose();
    const before = sessionFile(opts.sessionDir);
    expect(before).toContain('canary-db-42');

    const fork = await engine.create({
      ...options('parent'),
      ephemeral: true,
      turnContext: () => ({ job: 'summary' }),
    });
    faux.setResponses([
      (context, _o, _s, model) => {
        record(context, model.id);
        return fauxAssistantMessage('Summary: the team chose Postgres.');
      },
    ]);
    await fork.prompt('/skill:summarize-state Facts: none', { expand: true });
    fork.dispose();
    const call = seen.at(-1)!;
    expect(call.model).toBe('strong');
    expect(call.texts.join(' ')).toContain('canary-db-42'); // it saw the arena's own history
    expect(call.texts.join(' ')).toContain('Summarize the arena');
    expect(sessionFile(opts.sessionDir)).toBe(before); // and wrote nothing
    expect(readdirSync(opts.sessionDir).filter((f) => f.endsWith('.jsonl'))).toHaveLength(1);
  });
});

describe.skipIf(!piNode)('a bring-your-own key (ADR-043, faux providers)', () => {
  const mine = fauxProvider({
    provider: 'mine',
    models: [{ id: 'my-model', contextWindow: 100_000, maxTokens: 4_000 }],
  });
  const byo = new PiEngine({
    apiKey: 'faux-key',
    routing: { fast: ['fast'], strong: ['strong'], fallbacks: [] },
    dataDir: join(root, 'byo-data'),
    provider: 'faux',
    prepareRuntime: (runtime) => {
      runtime.registerNativeProvider(faux.provider);
      runtime.registerNativeProvider(mine.provider);
    },
  });
  const modelKey = { provider: 'mine', model: 'my-model', api_key: 'sk-mine-secret' };

  it('answers with the own key, and with the pool when the provider refuses it', async () => {
    await byo.init();
    const calls: string[] = [];
    const failures: { provider: string; status: number | null }[] = [];
    const handle = await byo.create({
      ...options('byo'),
      modelKey,
      onModelKeyFailed: (info) => failures.push(info),
    });
    mine.setResponses([
      (_c, _o, _s, model) => {
        calls.push(model.id);
        return fauxAssistantMessage('From my key.');
      },
      (_c, _o, _s, model) => {
        calls.push(model.id);
        return fauxAssistantMessage('', {
          stopReason: 'error',
          errorMessage: '401: Incorrect API key provided: sk-mi****cret',
        });
      },
    ]);
    faux.setResponses([
      (_c, _o, _s, model) => {
        calls.push(model.id);
        return fauxAssistantMessage('From the pool.');
      },
    ]);
    await handle.prompt('hello');
    expect(calls).toEqual(['my-model']);
    const events: HarnessEvent[] = [];
    handle.subscribe(collect(events));
    await handle.prompt('hello again');
    expect(calls).toEqual(['my-model', 'my-model', 'fast']);
    const last = events.filter((e) => e.type === 'message_end').at(-1) as unknown as {
      message: { content: { text?: string }[] };
    };
    expect(last.message.content[0]?.text).toBe('From the pool.');
    expect(failures).toEqual([{ provider: 'mine', status: 401 }]);
    handle.dispose();
  });

  it('without a key the pool answers, as before', async () => {
    const calls: string[] = [];
    const handle = await byo.create(options('byo-none'));
    faux.setResponses([
      (_c, _o, _s, model) => {
        calls.push(model.id);
        return fauxAssistantMessage('Pool.');
      },
    ]);
    await handle.prompt('hi');
    expect(calls).toEqual(['fast']);
    handle.dispose();
  });
});
