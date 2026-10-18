import type {
  AgentEngine,
  AgentHandle,
  AgentTool,
  CreateAgentOptions,
  HarnessEvent,
  PromptOptions,
} from './agent.js';
import type { ToolSet, ToolSource } from './app-tools.js';

// Test doubles for the harness seam: a scripted fake Pi session, so unit tests never call a model.

/** What a fake prompt does: emit these Pi-shaped events, then resolve (or throw). */
export type Script = (emit: (event: HarnessEvent) => void, text: string) => Promise<void> | void;

export const assistant = (text: string, extra: Record<string, unknown> = {}): HarnessEvent => ({
  type: 'message_end',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.001 } },
    model: 'test/model',
    stopReason: 'stop',
    ...extra,
  },
});

export const delta = (text: string): HarnessEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', delta: text },
});

/** Answers every prompt with "echo: <text>" unless a script is set. */
export class FakeHandle implements AgentHandle {
  readonly prompts: string[] = [];
  readonly promptOptions: (PromptOptions | undefined)[] = [];
  readonly steered: string[] = [];
  readonly listeners = new Set<(event: HarnessEvent) => void>();
  aborted = false;
  disposed = false;
  streaming = false;
  private release: (() => void) | undefined;

  constructor(
    readonly options: CreateAgentOptions,
    private readonly script?: Script,
  ) {}

  subscribe(listener: (event: HarnessEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: HarnessEvent): void {
    for (const l of this.listeners) l(event);
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.prompts.push(text);
    this.promptOptions.push(options);
    this.streaming = true;
    try {
      if (this.script) await this.script((e) => this.emit(e), text);
      else {
        this.emit(delta('echo'));
        this.emit(assistant(`echo: ${text.length}`));
        this.emit({ type: 'agent_settled' });
      }
    } finally {
      this.streaming = false;
    }
  }

  /** For scripts: wait until the test calls unblock(). */
  hold(): Promise<void> {
    return new Promise((resolve) => (this.release = resolve));
  }

  unblock(): void {
    this.release?.();
  }

  async steer(text: string): Promise<void> {
    this.steered.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.steered.push(text);
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.unblock();
  }

  async compact(): Promise<void> {}

  isStreaming(): boolean {
    return this.streaming;
  }

  contextUsage() {
    return { tokens: 100, limit: 1000 };
  }

  dispose(): void {
    this.disposed = true;
  }
}

export class FakeEngine implements AgentEngine {
  readonly model = 'test/model';
  readonly handles: FakeHandle[] = [];
  reason: string | null = null;
  script: Script | undefined;

  unavailableReason(): string | null {
    return this.reason;
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const handle = new FakeHandle(options, this.script);
    this.handles.push(handle);
    return handle;
  }
}

export class FakeTools implements ToolSource {
  calls = 0;
  constructor(private readonly list: AgentTool[] = []) {}

  async tools(): Promise<ToolSet> {
    this.calls += 1;
    return {
      tools: this.list,
      names: new Map(this.list.map((t) => [t.name, t.name.replace('_', '.')])),
      close: async () => undefined,
    };
  }
}
