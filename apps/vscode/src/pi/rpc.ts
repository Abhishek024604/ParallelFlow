// A small client for `pi --mode rpc`: correlates command responses by id, streams session events,
// and forwards extension UI requests. The child process is injected so tests can use a fake Pi.
import type { Readable, Writable } from 'node:stream';
import { JsonlDecoder, serializeJsonl } from './jsonl.js';

export interface ChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PiResponse {
  type: 'response';
  id?: string;
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface UiRequest {
  type: 'extension_ui_request';
  id: string;
  method: string;
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  timeout?: number;
  notifyType?: 'info' | 'warning' | 'error';
  [key: string]: unknown;
}

export type UiResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

/** Any stdout record that is neither a response nor a UI request. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export class PiExitedError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
  }
}

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export class PiRpc {
  private readonly decoder = new JsonlDecoder();
  private readonly pending = new Map<
    string,
    { resolve: (r: PiResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private readonly eventListeners = new Set<(e: PiEvent) => void>();
  private readonly uiListeners = new Set<(r: UiRequest) => void>();
  private readonly exitListeners = new Set<(e: PiExitedError) => void>();
  private nextId = 1;
  private exited: PiExitedError | undefined;
  /** Last lines of stderr, for a crash message. Never logged (they may quote prompts or code). */
  private stderrTail: string[] = [];

  constructor(
    private readonly child: ChildLike,
    private readonly commandTimeoutMs = 30_000,
  ) {
    child.stdout.on('data', (chunk: Buffer) => this.onLines(this.decoder.push(chunk)));
    child.stdout.on('end', () => this.onLines(this.decoder.end()));
    child.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString('utf8').split('\n').filter(Boolean);
      this.stderrTail = [...this.stderrTail, ...lines].slice(-20);
    });
    child.on('error', (err) =>
      this.handleExit(new PiExitedError(`Pi could not start: ${err.message}`, null)),
    );
    child.on('exit', (code, signal) =>
      this.handleExit(
        new PiExitedError(
          `Pi stopped (${signal ?? `exit code ${code}`})${this.stderrTail.length ? `: ${this.stderrTail.slice(-3).join(' ')}` : ''}`,
          code,
        ),
      ),
    );
  }

  get isRunning(): boolean {
    return this.exited === undefined;
  }

  onEvent(listener: (e: PiEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onUiRequest(listener: (r: UiRequest) => void): () => void {
    this.uiListeners.add(listener);
    return () => this.uiListeners.delete(listener);
  }

  onExit(listener: (e: PiExitedError) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private handleExit(err: PiExitedError): void {
    if (this.exited) return;
    this.exited = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const l of this.exitListeners) l(err);
  }

  /** Send a command and wait for its response. Rejects on `success: false`, timeout or exit. */
  async send(command: Record<string, unknown> & { type: string }): Promise<PiResponse> {
    if (this.exited) throw this.exited;
    const id = `c${this.nextId++}`;
    const promise = new Promise<PiResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi did not answer ${command.type} in time`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ ...command, id });
    const response = await promise;
    if (!response.success) throw new Error(response.error ?? `${command.type} failed`);
    return response;
  }

  respondUi(id: string, response: UiResponse): void {
    if (this.exited) return;
    this.write({ type: 'extension_ui_response', id, ...response });
  }

  /** Close stdin (Pi shuts down in order), then kill if it lingers. */
  stop(graceMs = 3000): void {
    if (this.exited) return;
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (!this.exited) this.child.kill();
    }, graceMs);
    timer.unref?.();
  }

  private write(record: unknown): void {
    this.child.stdin.write(serializeJsonl(record));
  }

  private onLines(lines: string[]): void {
    for (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // stdout is protocol-only; ignore anything unparseable
      }
      if (typeof record !== 'object' || record === null) continue;
      const r = record as { type?: unknown; id?: unknown; method?: unknown };
      if (r.type === 'response') {
        const id = typeof r.id === 'string' ? r.id : undefined;
        const p = id ? this.pending.get(id) : undefined;
        if (p && id) {
          clearTimeout(p.timer);
          this.pending.delete(id);
          p.resolve(record as PiResponse);
        }
        continue;
      }
      if (
        r.type === 'extension_ui_request' &&
        typeof r.id === 'string' &&
        typeof r.method === 'string'
      ) {
        for (const l of this.uiListeners) l(record as UiRequest);
        continue;
      }
      if (typeof r.type === 'string') {
        for (const l of this.eventListeners) l(record as PiEvent);
      }
    }
  }
}

export function isDialog(request: UiRequest): boolean {
  return DIALOG_METHODS.has(request.method);
}
