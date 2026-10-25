import { StreamSanitizer } from '@parallelflow/pi-parallelflow';
import type { RicError, RuntimeEventType, Usage } from '@parallelflow/runtime-client';
import type { HarnessEvent } from './agent.js';

// Pi events → RIC RuntimeEvents for one turn (ADR-035):
//   message_update text_delta        → message.delta, through the ParallelFlow stream filter (ids, secrets
//                                      and tool names are held back until they can be seen whole)
//   message_end (assistant)          → the rest of the filtered stream; the message itself was
//                                      cleaned by the extension's message_end hook. The turn's text
//                                      is sent once as message.completed
//                                      (the app stores the first message.completed it sees)
//   tool_execution_start / _end      → tool.called (argument keys only) / tool.result (status + code)
//   compaction_end                   → context.compacted
//   agent_settled                    → message.completed + turn.completed (usage)
//   assistant stopReason error       → turn.failed;  stopReason aborted / cancel() → turn.cancelled
// Nothing here logs; tool arguments and results never reach an event (rule 5: no tokens in events).

export type Emit = (type: RuntimeEventType, data?: Record<string, unknown>) => void;

interface Citation {
  resource_type: string;
  resource_id: string;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The text parts of an assistant message. */
export function messageText(message: Record<string, unknown>): string {
  const content = message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => asRecord(part))
    .filter((part) => part['type'] === 'text' && typeof part['text'] === 'string')
    .map((part) => part['text'] as string)
    .join('');
}

/** Argument names with the values removed (RIC ToolCalled.args_redacted). */
export function redactArgs(args: unknown): Record<string, string> {
  return Object.fromEntries(Object.keys(asRecord(args)).map((key) => [key, '[redacted]']));
}

/** A tool error's short code ("SCOPE_MISMATCH: …" → SCOPE_MISMATCH), else "error". */
export function errorCodeOf(result: unknown): string {
  const record = asRecord(result);
  const details = asRecord(record['details']);
  if (typeof details['code'] === 'string') return details['code'];
  const text = typeof result === 'string' ? result : messageText(record);
  const match = /^([A-Z][A-Z_]{2,40})\b/.exec(text.trim());
  return match?.[1] ?? 'error';
}

/** Why a model call failed, safe to log: the model, the provider's HTTP status and a short reason. */
export interface ModelError {
  model: string;
  status: number | null;
  reason: string;
}

/**
 * The provider error of an assistant message that stopped with an error (e.g. "400: Reasoning is
 * mandatory for this endpoint"). Quoted text is removed and the reason is cut short, so a provider
 * that echoes part of a request never puts content in the logs (rule 7).
 */
export function modelErrorOf(message: Record<string, unknown>, fallbackModel: string): ModelError {
  const raw = typeof message['errorMessage'] === 'string' ? message['errorMessage'] : '';
  const status = /^\s*(\d{3})\b/.exec(raw)?.[1];
  let reason = raw;
  try {
    const json = JSON.parse(raw.replace(/^\s*\d{3}:\s*/, '')) as { message?: unknown };
    if (typeof json.message === 'string') reason = json.message;
  } catch {
    // Not JSON: the text as given.
  }
  reason = reason
    .replace(/^\s*\d{3}:\s*/, '')
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '…')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return {
    model: typeof message['model'] === 'string' ? message['model'] : fallbackModel,
    status: status ? Number(status) : null,
    reason: reason || 'unknown',
  };
}

export class TurnMapper {
  private readonly texts: string[] = [];
  private readonly citations = new Map<string, Citation>();
  private readonly usage = { input: 0, output: 0, cached: 0, cost: 0, steps: 0 };
  private responseModel: string | undefined;
  private failure: RicError | undefined;
  private aborted = false;
  private done = false;

  constructor(
    private readonly emit: Emit,
    /** Model-facing tool name → App Tools name. */
    private readonly toolNames: ReadonlyMap<string, string>,
    private readonly model: string,
    /** Told why a model call failed (provider status and reason; never prompts or content). */
    private readonly onModelError?: (info: ModelError) => void,
  ) {}

  get finished(): boolean {
    return this.done;
  }

  handle(event: HarnessEvent): void {
    if (this.done) return;
    switch (event.type) {
      case 'message_update': {
        const update = asRecord(event['assistantMessageEvent']);
        if (update['type'] === 'text_delta' && typeof update['delta'] === 'string') {
          // Separate the texts of consecutive assistant messages, as message.completed will.
          if (!update['delta']) break;
          const prefix = this.pendingSeparator ? '\n\n' : '';
          this.pendingSeparator = false;
          this.delta(this.live.push(prefix + update['delta']));
        }
        break;
      }
      case 'message_end': {
        const message = asRecord(event['message']);
        if (message['role'] !== 'assistant') break;
        this.delta(this.live.flush());
        this.usage.steps += 1;
        const usage = asRecord(message['usage']);
        this.usage.input += num(usage['input']);
        this.usage.output += num(usage['output']);
        this.usage.cached += num(usage['cacheRead']);
        this.usage.cost += num(asRecord(usage['cost'])['total']);
        if (typeof message['model'] === 'string') this.responseModel = message['model'];
        const text = messageText(message).trim();
        if (text) {
          this.texts.push(text);
          this.pendingSeparator = true;
        }
        if (message['stopReason'] === 'aborted') this.aborted = true;
        if (message['stopReason'] === 'error') {
          this.onModelError?.(modelErrorOf(message, this.model));
          this.failure = {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'The AI model could not answer',
            retryable: true,
          };
        } else {
          this.failure = undefined;
        }
        break;
      }
      case 'tool_execution_start': {
        const tool = this.toolNameOf(event['toolName']);
        const args = asRecord(event['args']);
        if (tool === 'artifacts.read' && typeof args['artifact_id'] === 'string') {
          const id = args['artifact_id'];
          this.citations.set(`artifact:${id}`, { resource_type: 'artifact', resource_id: id });
        }
        this.emit('tool.called', {
          tool,
          source: this.toolNames.has(String(event['toolName'])) ? 'app_tools' : 'bundled',
          args_redacted: redactArgs(args),
        });
        break;
      }
      case 'tool_execution_end': {
        const tool = this.toolNameOf(event['toolName']);
        const isError = event['isError'] === true;
        this.emit('tool.result', {
          tool,
          status: isError ? 'error' : 'ok',
          summary: isError ? errorCodeOf(event['result']) : 'ok',
        });
        break;
      }
      case 'compaction_end':
        if (event['aborted'] !== true && event['result']) this.emit('context.compacted', {});
        break;
      case 'agent_settled':
        this.finish();
        break;
      default:
        break;
    }
  }

  private pendingSeparator = false;
  private readonly live = new StreamSanitizer();

  private delta(text: string): void {
    if (text) this.emit('message.delta', { text });
  }

  private toolNameOf(raw: unknown): string {
    const name = String(raw ?? '');
    return this.toolNames.get(name) ?? name;
  }

  /** Ends the turn from what was collected. Idempotent. */
  finish(): void {
    if (this.done) return;
    if (this.aborted) {
      this.cancel();
      return;
    }
    const text = this.texts.join('\n\n');
    if (text) {
      this.emit('message.completed', {
        text,
        ...(this.citations.size && { citations: [...this.citations.values()] }),
      });
    }
    this.done = true;
    if (this.failure && !text) {
      this.emit('turn.failed', { error: this.failure });
      return;
    }
    this.emit('turn.completed', { usage: this.usageReport() });
  }

  /** Ends the turn as failed. Idempotent. */
  fail(error: RicError): void {
    if (this.done) return;
    this.done = true;
    this.emit('turn.failed', { error });
  }

  /** Ends the turn as cancelled. Idempotent. */
  cancel(): void {
    if (this.done) return;
    this.done = true;
    this.emit('turn.cancelled', {});
  }

  usageReport(): Usage {
    return {
      input_tokens: this.usage.input,
      cached_tokens: this.usage.cached,
      output_tokens: this.usage.output,
      ...(this.usage.cost > 0 && { cost_usd: Number(this.usage.cost.toFixed(6)) }),
      steps: this.usage.steps,
      model: this.responseModel ?? this.model,
    };
  }
}
