import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PiRpc, type ChildLike, type PiEvent, type UiRequest } from './rpc.js';
import { Transcript } from './transcript.js';

/** A fake `pi --mode rpc`: we read what the client writes and write recorded records back. */
function fakePi() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const written: Record<string, unknown>[] = [];
  let buf = '';
  stdin.on('data', (c: Buffer) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      written.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      buf = buf.slice(i + 1);
    }
  });
  const child = Object.assign(emitter, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      emitter.emit('exit', null, 'SIGTERM');
      return true;
    },
  }) as unknown as ChildLike;
  return {
    child,
    stdout,
    stderr,
    emitter,
    written,
    emit: (r: unknown) => stdout.write(`${JSON.stringify(r)}\n`),
  };
}

const tick = () => new Promise((r) => setImmediate(r));

// Recorded from a real Pi 1.0.1 RPC run (contents shortened).
const RECORDED = [
  { type: 'agent_start' },
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Reading the file' },
  },
  {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Reading the file' }] },
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'call_1',
    toolName: 'edit',
    args: { path: 'src/a.ts', edits: [] },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_1',
    toolName: 'edit',
    result: { content: [{ type: 'text', text: 'Edited src/a.ts' }], details: { diff: '-a\n+b' } },
    isError: false,
  },
  {
    type: 'tool_execution_start',
    toolCallId: 'call_2',
    toolName: 'bash',
    args: { command: 'rm -rf /' },
  },
  {
    type: 'tool_execution_end',
    toolCallId: 'call_2',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'The person denied this command.' }] },
    isError: true,
  },
  { type: 'agent_end', messages: [], willRetry: false },
  { type: 'agent_settled' },
];

describe('PiRpc', () => {
  it('correlates responses by id and rejects failures', async () => {
    const pi = fakePi();
    const rpc = new PiRpc(pi.child);
    const p1 = rpc.send({ type: 'get_state' });
    const p2 = rpc.send({ type: 'set_model', provider: 'x', modelId: 'y' });
    await tick();
    expect(pi.written.map((w) => w.type)).toEqual(['get_state', 'set_model']);
    // Answer out of order.
    pi.emit({
      type: 'response',
      id: pi.written[1]!.id,
      command: 'set_model',
      success: false,
      error: 'Model not found',
    });
    pi.emit({
      type: 'response',
      id: pi.written[0]!.id,
      command: 'get_state',
      success: true,
      data: { ok: 1 },
    });
    await expect(p2).rejects.toThrow('Model not found');
    await expect(p1).resolves.toMatchObject({ data: { ok: 1 } });
  });

  it('streams recorded events into the transcript, U+2028 intact', async () => {
    const pi = fakePi();
    const rpc = new PiRpc(pi.child);
    const transcript = new Transcript();
    const seen: PiEvent[] = [];
    rpc.onEvent((e) => {
      seen.push(e);
      transcript.apply(e);
    });
    // Write the whole recording as one chunk to exercise framing.
    pi.stdout.write(RECORDED.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await tick();
    expect(seen).toHaveLength(RECORDED.length);
    expect(transcript.state).toBe('idle');
    const [assistant, edit, bash] = transcript.items;
    expect(assistant).toMatchObject({
      kind: 'assistant',
      text: 'Reading the file',
      streaming: false,
    });
    expect(edit).toMatchObject({
      kind: 'tool',
      tool: 'edit',
      summary: 'src/a.ts',
      status: 'ok',
      diff: '-a\n+b',
    });
    expect(bash).toMatchObject({ kind: 'tool', tool: 'bash', status: 'error' });
    expect(transcript.stats.edits).toBe(1);
  });

  it('forwards UI requests and writes UI responses', async () => {
    const pi = fakePi();
    const rpc = new PiRpc(pi.child);
    const requests: UiRequest[] = [];
    rpc.onUiRequest((r) => requests.push(r));
    pi.emit({
      type: 'extension_ui_request',
      id: 'ui-1',
      method: 'select',
      title: 'x',
      options: ['a'],
    });
    await tick();
    expect(requests[0]).toMatchObject({ id: 'ui-1', method: 'select' });
    rpc.respondUi('ui-1', { value: 'a' });
    await tick();
    expect(pi.written.at(-1)).toEqual({ type: 'extension_ui_response', id: 'ui-1', value: 'a' });
  });

  it('rejects pending commands when Pi exits and ignores non-JSON stdout', async () => {
    const pi = fakePi();
    const rpc = new PiRpc(pi.child);
    const exits: string[] = [];
    rpc.onExit((e) => exits.push(e.message));
    pi.stdout.write('not json\n');
    pi.stderr.write('boom happened\n');
    const p = rpc.send({ type: 'get_state' });
    await tick();
    pi.emitter.emit('exit', 1, null);
    await expect(p).rejects.toThrow(/exit code 1.*boom happened/);
    expect(rpc.isRunning).toBe(false);
    expect(exits).toHaveLength(1);
    await expect(rpc.send({ type: 'get_state' })).rejects.toThrow();
  });
});
