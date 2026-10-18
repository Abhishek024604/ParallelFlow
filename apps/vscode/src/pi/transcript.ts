// Folds Pi's RPC session events into a transcript the sidebar can render: messages, tool calls with
// short summaries, file diffs, and notices. Pure, so it is easy to test with recorded events.
import type { PiEvent } from './rpc.js';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; thinking: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      summary: string;
      status: 'running' | 'ok' | 'error';
      output?: string;
      diff?: string;
    }
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string };

export type AgentState = 'idle' | 'working' | 'waiting' | 'stopped';

const OUTPUT_LIMIT = 4000;
const ITEM_LIMIT = 400;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) =>
      c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        ? String((c as { text?: unknown }).text ?? '')
        : '',
    )
    .join('');
}

function clip(s: string, n = OUTPUT_LIMIT): string {
  return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s;
}

export function summarizeToolCall(tool: string, args: Record<string, unknown>): string {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
  switch (tool) {
    case 'bash':
      return str('command');
    case 'read':
    case 'write':
    case 'edit':
      return str('path');
    case 'ls':
      return str('path') || '.';
    case 'find':
    case 'grep':
      return `${str('pattern')}${str('path') ? ` in ${str('path')}` : ''}`;
    case 'ask_user':
      return str('question');
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') : tool;
  }
}

/** Build a unified-ish diff for a `write`, where Pi gives no diff of its own. */
function writePreview(args: Record<string, unknown>): string | undefined {
  if (typeof args.content !== 'string') return undefined;
  return clip(
    args.content
      .split('\n')
      .map((l) => `+${l}`)
      .join('\n'),
    OUTPUT_LIMIT,
  );
}

export class Transcript {
  items: TranscriptItem[] = [];
  state: AgentState = 'idle';
  private counter = 0;
  private currentAssistant: Extract<TranscriptItem, { kind: 'assistant' }> | undefined;
  private readonly tools = new Map<string, Extract<TranscriptItem, { kind: 'tool' }>>();
  /** Counters for progress summaries (no contents). */
  stats = { edits: 0, commands: 0, files: new Set<string>() };

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  private push(item: TranscriptItem): void {
    this.items.push(item);
    if (this.items.length > ITEM_LIMIT) this.items.splice(0, this.items.length - ITEM_LIMIT);
  }

  addUser(text: string): void {
    this.push({ kind: 'user', id: this.nextId('u'), text });
  }

  notice(level: 'info' | 'warning' | 'error', text: string): void {
    this.push({ kind: 'notice', id: this.nextId('n'), level, text });
  }

  /** Apply one event. Returns true when something visible changed. */
  apply(e: PiEvent): boolean {
    switch (e.type) {
      case 'agent_start':
        this.state = 'working';
        return true;
      case 'agent_settled':
        this.state = 'idle';
        if (this.currentAssistant) this.currentAssistant.streaming = false;
        this.currentAssistant = undefined;
        return true;
      case 'message_start': {
        const message = e.message as { role?: string } | undefined;
        if (message?.role === 'assistant') {
          this.currentAssistant = {
            kind: 'assistant',
            id: this.nextId('a'),
            text: '',
            thinking: '',
            streaming: true,
          };
          this.push(this.currentAssistant);
          return true;
        }
        return false;
      }
      case 'message_update': {
        const ev = e.assistantMessageEvent as
          { type?: string; delta?: string; content?: string } | undefined;
        const a = this.currentAssistant;
        if (!ev || !a) return false;
        if (ev.type === 'text_delta') a.text += ev.delta ?? '';
        else if (ev.type === 'thinking_delta') a.thinking += ev.delta ?? '';
        else return false;
        return true;
      }
      case 'message_end': {
        const message = e.message as
          | { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
          | undefined;
        const a = this.currentAssistant;
        if (message?.role !== 'assistant' || !a) return false;
        const final = textOf(message.content);
        if (final) a.text = final;
        a.streaming = false;
        if (a.text === '' && a.thinking === '') this.items = this.items.filter((i) => i !== a);
        if (message.stopReason === 'error' && message.errorMessage) {
          this.notice('error', `Model error: ${message.errorMessage}`);
        }
        this.currentAssistant = undefined;
        return true;
      }
      case 'tool_execution_start': {
        const id = String(e.toolCallId ?? this.nextId('t'));
        const tool = String(e.toolName ?? 'tool');
        const args = (e.args ?? {}) as Record<string, unknown>;
        const item: Extract<TranscriptItem, { kind: 'tool' }> = {
          kind: 'tool',
          id,
          tool,
          summary: summarizeToolCall(tool, args),
          status: 'running',
        };
        if (tool === 'write') {
          const preview = writePreview(args);
          if (preview) item.diff = preview;
        }
        this.tools.set(id, item);
        this.push(item);
        return true;
      }
      case 'tool_execution_end': {
        const id = String(e.toolCallId ?? '');
        const item = this.tools.get(id);
        if (!item) return false;
        const result = (e.result ?? {}) as { content?: unknown; details?: { diff?: unknown } };
        item.status = e.isError ? 'error' : 'ok';
        const out = textOf(result.content);
        if (out) item.output = clip(out);
        if (typeof result.details?.diff === 'string') item.diff = clip(result.details.diff);
        if (!e.isError) {
          if (item.tool === 'write' || item.tool === 'edit') {
            this.stats.edits += 1;
            this.stats.files.add(item.summary);
          } else if (item.tool === 'bash') this.stats.commands += 1;
        }
        this.tools.delete(id);
        return true;
      }
      case 'auto_retry_start':
        this.notice(
          'warning',
          `Model call failed, retrying (${String(e.attempt)}/${String(e.maxAttempts)})`,
        );
        return true;
      case 'compaction_start':
        this.notice('info', 'Summarising earlier conversation to save context');
        return true;
      case 'extension_error':
        this.notice('error', `Guard error: ${String(e.error ?? '')}`);
        return true;
      default:
        return false;
    }
  }
}
