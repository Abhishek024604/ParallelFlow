import { describe, expect, it } from 'vitest';
import { errorCodeOf, redactArgs, TurnMapper } from './mapping.js';
import { assistant, delta } from './testing.js';

function mapper() {
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const m = new TurnMapper(
    (type, data) => events.push({ type, ...(data && { data }) }),
    new Map([['artifacts_read', 'artifacts.read']]),
    'fallback/model',
  );
  return { m, events };
}

describe('Pi → RIC event mapping', () => {
  it('maps deltas, a tool round-trip and the final answer', () => {
    const { m, events } = mapper();
    m.handle(delta('Let me look.'));
    m.handle(assistant('Let me look.'));
    m.handle({
      type: 'tool_execution_start',
      toolCallId: '1',
      toolName: 'artifacts_read',
      args: { artifact_id: 'a1', secret: 'canary-value' },
    });
    m.handle({
      type: 'tool_execution_end',
      toolCallId: '1',
      toolName: 'artifacts_read',
      result: { content: [{ type: 'text', text: 'canary-result' }] },
      isError: false,
    });
    m.handle(delta('It says hi.'));
    m.handle(assistant('It says hi.'));
    m.handle({ type: 'agent_settled' });

    // Deltas are filtered and may arrive in pieces: merge consecutive ones.
    const merged: { type: string; data?: Record<string, unknown> }[] = [];
    for (const e of events) {
      const last = merged.at(-1);
      if (e.type === 'message.delta' && last?.type === 'message.delta') {
        last.data = { text: `${String(last.data?.['text'])}${String(e.data?.['text'])}` };
      } else merged.push({ ...e });
    }
    expect(merged.map((e) => e.type)).toEqual([
      'message.delta',
      'tool.called',
      'tool.result',
      'message.delta',
      'message.completed',
      'turn.completed',
    ]);
    expect(merged[0]!.data).toEqual({ text: 'Let me look.' });
    expect(merged[1]!.data).toEqual({
      tool: 'artifacts.read',
      source: 'app_tools',
      args_redacted: { artifact_id: '[redacted]', secret: '[redacted]' },
    });
    expect(merged[2]!.data).toEqual({ tool: 'artifacts.read', status: 'ok', summary: 'ok' });
    expect(merged[3]!.data).toEqual({ text: '\n\nIt says hi.' });
    expect(merged[4]!.data).toEqual({
      text: 'Let me look.\n\nIt says hi.',
      citations: [{ resource_type: 'artifact', resource_id: 'a1' }],
    });
    expect(merged[5]!.data).toEqual({
      usage: {
        input_tokens: 20,
        cached_tokens: 4,
        output_tokens: 10,
        cost_usd: 0.002,
        steps: 2,
        model: 'test/model',
      },
    });
    expect(JSON.stringify(events)).not.toContain('canary');
  });

  it('filters ids and secrets out of live deltas, even split across deltas', () => {
    const { m, events } = mapper();
    m.handle(delta('Read plan.md (ID: 0190f0aa-1111-'));
    m.handle(delta('7222-8333-444455556666) and key sk-abcdefghijklmnopqrstuvwx ok'));
    m.handle(assistant('Read plan.md and key [hidden] ok'));
    const live = events
      .filter((e) => e.type === 'message.delta')
      .map((e) => e.data?.['text'])
      .join('');
    expect(live).toBe('Read plan.md and key [hidden] ok');
  });

  it('reports a tool error by code only', () => {
    const { m, events } = mapper();
    m.handle({
      type: 'tool_execution_end',
      toolName: 'artifacts_read',
      result: { content: [{ type: 'text', text: 'SCOPE_MISMATCH: That artifact is not here' }] },
      isError: true,
    });
    expect(events[0]!.data).toEqual({
      tool: 'artifacts.read',
      status: 'error',
      summary: 'SCOPE_MISMATCH',
    });
    expect(errorCodeOf('nothing useful')).toBe('error');
    expect(redactArgs(null)).toEqual({});
  });

  it('fails the turn when the model errored without answering', () => {
    const { m, events } = mapper();
    m.handle(assistant('', { stopReason: 'error', errorMessage: 'provider said no' }));
    m.handle({ type: 'agent_settled' });
    expect(events).toEqual([
      {
        type: 'turn.failed',
        data: {
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'The AI model could not answer',
            retryable: true,
          },
        },
      },
    ]);
  });

  it('maps an aborted run to turn.cancelled, compaction to context.compacted, and ends once', () => {
    const { m, events } = mapper();
    m.handle({ type: 'compaction_end', aborted: false, result: { summary: 'x' } });
    m.handle(assistant('partial', { stopReason: 'aborted' }));
    m.handle({ type: 'agent_settled' });
    m.finish();
    m.fail({ code: 'INTERNAL', message: 'late' });
    expect(events.map((e) => e.type)).toEqual(['context.compacted', 'turn.cancelled']);
  });
});
