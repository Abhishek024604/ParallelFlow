import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AgentEngine,
  type AgentHandle,
  type AgentTool,
  type CreateAgentOptions,
  type HarnessEvent,
  ToolCallError,
} from './agent.js';

// The Pi harness behind the AgentEngine seam (ADR-035). @earendil-works/pi-coding-agent needs
// Node >= 22.19, so it is an optional dependency loaded with a dynamic import: on an older Node the
// runtime still starts and answers RIC calls, and every turn fails fast with RUNTIME_UNAVAILABLE.
//
// Isolation and lock-down per session:
//   - its own Pi session file under <session dir>/pi (no shared memory, cache or compaction);
//   - cwd = an empty folder of its own, a custom ResourceLoader (no AGENTS.md / context files, skills,
//     prompt templates, themes or extensions) and its own agentDir (no global ~/.pi config);
//   - only the App Tools are enabled: Pi's built-in tools (read, write, edit, bash, …) never are;
//   - OpenRouter is the only provider; the key is set in memory (never written to disk).

/** The parts of Pi's SDK this file uses (typed locally so the app typechecks without Pi). */
interface PiSession {
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<unknown>;
  readonly isStreaming: boolean;
  getContextUsage(): { tokens: number | null; contextWindow: number } | undefined;
  dispose(): void;
}

interface PiModelRuntime {
  setRuntimeApiKey(provider: string, key: string): Promise<void>;
  getModel(provider: string, id: string): unknown;
}

interface PiCodingAgent {
  ModelRuntime: { create(options: Record<string, unknown>): Promise<PiModelRuntime> };
  SessionManager: {
    create(cwd: string, sessionDir?: string): unknown;
    open(path: string, sessionDir?: string, cwdOverride?: string): unknown;
  };
  SettingsManager: { inMemory(settings?: Record<string, unknown>): unknown };
  createExtensionRuntime(): unknown;
  createAgentSession(options: Record<string, unknown>): Promise<{ session: PiSession }>;
}

interface PiAi {
  Type: { Unsafe(schema: Record<string, unknown>): unknown };
}

export const PI_MIN_NODE = '22.19.0';
export const OPENROUTER = 'openrouter';

function nodeAtLeast(min: string, current = process.versions.node): boolean {
  const [a = 0, b = 0, c = 0] = current.split('.').map(Number);
  const [x = 0, y = 0, z = 0] = min.split('.').map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

/** Dynamic import by a variable name: TypeScript does not need Pi's types to compile this app. */
async function importOptional<T>(name: string): Promise<T | null> {
  try {
    return (await import(name)) as T;
  } catch {
    return null;
  }
}

export interface PiEngineOptions {
  apiKey: string | undefined;
  model: string;
  /** Root data folder (auth/models files of Pi's model runtime; never holds the key). */
  dataDir: string;
}

export class PiEngine implements AgentEngine {
  private pi: PiCodingAgent | null = null;
  private ai: PiAi | null = null;
  private modelRuntime: PiModelRuntime | null = null;
  private loadError: string | null = null;

  readonly model: string;

  constructor(private readonly options: PiEngineOptions) {
    this.model = options.model;
  }

  /** Loads Pi once. Call at startup; failures become unavailableReason(). */
  async init(): Promise<void> {
    if (!nodeAtLeast(PI_MIN_NODE)) {
      this.loadError = `The AI runtime needs Node ${PI_MIN_NODE} or newer (this is ${process.versions.node}).`;
      return;
    }
    this.pi = await importOptional<PiCodingAgent>('@earendil-works/pi-coding-agent');
    this.ai = await importOptional<PiAi>('@earendil-works/pi-ai');
    if (!this.pi || !this.ai) {
      this.loadError = 'The Pi harness is not installed (run pnpm install on Node 22.19+).';
      return;
    }
    if (!this.options.apiKey) return;
    mkdirSync(this.options.dataDir, { recursive: true });
    const runtime = await this.pi.ModelRuntime.create({
      authPath: join(this.options.dataDir, 'pi-auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey(OPENROUTER, this.options.apiKey);
    if (!runtime.getModel(OPENROUTER, this.options.model)) {
      this.loadError = `RUNTIME_MODEL "${this.options.model}" is not an OpenRouter model Pi knows.`;
      return;
    }
    this.modelRuntime = runtime;
  }

  unavailableReason(): string | null {
    if (this.loadError) return this.loadError;
    if (!this.options.apiKey) return "AI isn't connected yet: OPENROUTER_API_KEY is not set.";
    if (!this.pi || !this.modelRuntime) return 'The AI runtime is still starting.';
    return null;
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const pi = this.pi;
    const ai = this.ai;
    const modelRuntime = this.modelRuntime;
    if (!pi || !ai || !modelRuntime) throw new Error(this.unavailableReason() ?? 'unavailable');
    for (const dir of [options.sessionDir, options.cwd, options.agentDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const existing = readdirSync(options.sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort();
    const last = existing[existing.length - 1];
    const sessionManager =
      last && existsSync(join(options.sessionDir, last))
        ? pi.SessionManager.open(join(options.sessionDir, last), options.sessionDir, options.cwd)
        : pi.SessionManager.create(options.cwd, options.sessionDir);

    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => options.systemPrompt,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => undefined,
      reload: async () => undefined,
    };
    const customTools = options.tools.map((tool) => toPiTool(tool, ai));
    const { session } = await pi.createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      model: modelRuntime.getModel(OPENROUTER, this.model),
      thinkingLevel: 'off',
      modelRuntime,
      resourceLoader,
      // Allowlist = the App Tools only. Built-in tools stay off even if the list is empty.
      tools: options.tools.map((t) => t.name),
      noTools: 'all',
      customTools,
      sessionManager,
      settingsManager: pi.SettingsManager.inMemory({
        compaction: { enabled: true },
        retry: { enabled: true, maxRetries: 2 },
      }),
    });

    return {
      subscribe: (listener) => session.subscribe(listener),
      prompt: (text) => session.prompt(text, { expandPromptTemplates: false }),
      steer: (text) => session.steer(text),
      followUp: (text) => session.followUp(text),
      abort: () => session.abort(),
      compact: async () => {
        await session.compact();
      },
      isStreaming: () => session.isStreaming,
      contextUsage: () => {
        const usage = session.getContextUsage();
        return usage ? { tokens: usage.tokens, limit: usage.contextWindow } : undefined;
      },
      dispose: () => session.dispose(),
    };
  }
}

/** An AgentTool as a Pi ToolDefinition (TypeBox schema from the MCP JSON Schema). */
function toPiTool(tool: AgentTool, ai: PiAi): Record<string, unknown> {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: ai.Type.Unsafe(tool.parameters),
    execute: async (_id: string, params: unknown, signal: AbortSignal | undefined) => {
      try {
        const text = await tool.execute((params ?? {}) as Record<string, unknown>, signal);
        return { content: [{ type: 'text', text }], details: { status: 'ok' } };
      } catch (err) {
        // Pi marks a thrown tool as an error result; the message is what the model reads.
        if (err instanceof ToolCallError)
          throw new Error(
            err.message.startsWith(err.code) ? err.message : `${err.code}: ${err.message}`,
          );
        throw new Error('ERROR: the tool failed');
      }
    },
  };
}
