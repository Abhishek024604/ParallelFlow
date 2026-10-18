import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createQuestionBridge,
  SARAS_TOOL_NAMES,
  type SarasRouterOptions,
  sarasResourceLoaderOptions,
  VIRTUAL_MODEL_ID,
  VIRTUAL_PROVIDER,
} from '@saras/pi-saras';
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
// Every AI-layer function is a Pi extension point, from @saras/pi-saras:
//   - the Saras extension (context sections, guardrails, autonomy layer 1, ask_user, load_skill,
//     custom compaction, the saras/auto virtual model) is the only extension loaded;
//   - the package's skills and prompt templates are the only skills and templates;
//   - context files, themes and every other discovery are off.
//
// Isolation and lock-down per session:
//   - its own Pi session file under <session dir>/pi, its own ModelRuntime (the virtual model's
//     router closes over that session's turn data), its own extension closure: nothing shared;
//   - cwd = an empty folder of its own and its own agentDir (no global ~/.pi config);
//   - only the App Tools and the extension's two tools are enabled: Pi's built-in tools (read,
//     write, edit, bash, …) never are;
//   - OpenRouter is the only provider; the key is set in memory (never written to disk).
// An ephemeral fork (summaries) reads the parent's session file into an in-memory session manager:
// nothing is written anywhere, so the parent's history is untouched.

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type PiAi = typeof import('@earendil-works/pi-ai');
type ModelRuntime = Awaited<ReturnType<PiSdk['ModelRuntime']['create']>>;

export const PI_MIN_NODE = '22.19.0';
export const OPENROUTER = 'openrouter';

function nodeAtLeast(min: string, current = process.versions.node): boolean {
  const [a = 0, b = 0, c = 0] = current.split('.').map(Number);
  const [x = 0, y = 0, z = 0] = min.split('.').map(Number);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

/** Dynamic import by a variable name, so a missing optional dependency is not fatal. */
async function importOptional<T>(name: string): Promise<T | null> {
  try {
    return (await import(name)) as T;
  } catch {
    return null;
  }
}

export interface PiEngineOptions {
  apiKey: string | undefined;
  /** Model routing (config.ts). Ids Pi does not know are skipped. */
  routing: { fast: string[]; strong: string[]; fallbacks: string[] };
  /** Root data folder (auth file of Pi's model runtime; never holds the key). */
  dataDir: string;
  /** The physical provider. Tests use Pi's faux provider. */
  provider?: string;
  /** Tests: adds a provider to each model runtime (e.g. Pi's faux provider). */
  prepareRuntime?: (runtime: ModelRuntime) => void | Promise<void>;
}

export class PiEngine implements AgentEngine {
  private pi: PiSdk | null = null;
  private ai: PiAi | null = null;
  private loadError: string | null = null;
  private ready = false;
  /** The routing with only the ids Pi knows. */
  private known: SarasRouterOptions | null = null;

  constructor(private readonly options: PiEngineOptions) {}

  private get provider(): string {
    return this.options.provider ?? OPENROUTER;
  }

  /** The strong model (usage reports when a response names none). */
  get model(): string {
    return this.known?.strong[0] ?? this.options.routing.strong[0] ?? '';
  }

  get models(): string[] {
    const r = this.known ?? this.options.routing;
    return [...new Set([...r.strong, ...r.fast, ...r.fallbacks])];
  }

  /** Configured ids Pi does not know (skipped). Safe to log. */
  unknownModels: string[] = [];

  /** Loads Pi once. Call at startup; failures become unavailableReason(). */
  async init(): Promise<void> {
    if (!nodeAtLeast(PI_MIN_NODE)) {
      this.loadError = `The AI runtime needs Node ${PI_MIN_NODE} or newer (this is ${process.versions.node}).`;
      return;
    }
    this.pi = await importOptional<PiSdk>('@earendil-works/pi-coding-agent');
    this.ai = await importOptional<PiAi>('@earendil-works/pi-ai');
    if (!this.pi || !this.ai) {
      this.loadError = 'The Pi harness is not installed (run pnpm install on Node 22.19+).';
      return;
    }
    if (!this.options.apiKey) return;
    const probe = await this.runtime();
    const knows = (id: string) => !!probe.getModel(this.provider, id);
    const keep = (ids: readonly string[]) => ids.filter(knows);
    const r = this.options.routing;
    this.unknownModels = [...new Set([...r.fast, ...r.strong, ...r.fallbacks])].filter(
      (id) => !knows(id),
    );
    const known = {
      provider: this.provider,
      fast: keep(r.fast),
      strong: keep(r.strong),
      fallbacks: keep(r.fallbacks),
    };
    if (!known.fast.length && !known.strong.length && !known.fallbacks.length) {
      this.loadError = `None of the configured models (${this.models.join(', ')}) is an OpenRouter model Pi knows.`;
      return;
    }
    // A tier with no known model borrows the other one.
    if (!known.fast.length) known.fast = known.strong.length ? known.strong : known.fallbacks;
    if (!known.strong.length) known.strong = known.fast;
    const window = probe.getModel(this.provider, known.strong[0] ?? '');
    this.known = {
      ...known,
      ...(window?.contextWindow && { contextWindow: window.contextWindow }),
      ...(window?.maxTokens && { maxTokens: window.maxTokens }),
    };
    this.ready = true;
  }

  /** A model runtime of its own (per session: the virtual model's router is per session). */
  private async runtime(): Promise<ModelRuntime> {
    const pi = this.pi;
    if (!pi) throw new Error('Pi is not loaded');
    mkdirSync(this.options.dataDir, { recursive: true });
    const runtime = await pi.ModelRuntime.create({
      authPath: join(this.options.dataDir, 'pi-auth.json'),
      modelsPath: null,
      allowModelNetwork: false,
    });
    await this.options.prepareRuntime?.(runtime);
    if (this.options.apiKey) await runtime.setRuntimeApiKey(this.provider, this.options.apiKey);
    return runtime;
  }

  unavailableReason(): string | null {
    if (this.loadError) return this.loadError;
    if (!this.options.apiKey) return "AI isn't connected yet: OPENROUTER_API_KEY is not set.";
    if (!this.pi || !this.ready) return 'The AI runtime is still starting.';
    return null;
  }

  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    const pi = this.pi;
    const ai = this.ai;
    const router = this.known;
    if (!pi || !ai || !router) throw new Error(this.unavailableReason() ?? 'unavailable');
    for (const dir of [options.sessionDir, options.cwd, options.agentDir]) {
      mkdirSync(dir, { recursive: true });
    }
    const last = readdirSync(options.sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .pop();
    const lastPath = last ? join(options.sessionDir, last) : undefined;
    const sessionManager = options.ephemeral
      ? pi.SessionManager.inMemory(
          options.cwd,
          undefined,
          lastPath && existsSync(lastPath)
            ? pi.parseSessionEntries(readFileSync(lastPath, 'utf8'))
            : undefined,
        )
      : lastPath && existsSync(lastPath)
        ? pi.SessionManager.open(lastPath, options.sessionDir, options.cwd)
        : pi.SessionManager.create(options.cwd, options.sessionDir);

    const modelRuntime = await this.runtime();
    const settingsManager = pi.SettingsManager.inMemory({
      compaction: { enabled: true },
      // One retry per model in the longest chain; the router moves to the next model each time.
      retry: {
        enabled: true,
        maxRetries: Math.max(
          2,
          new Set([...router.fast, ...router.strong, ...router.fallbacks]).size,
        ),
        baseDelayMs: 500,
      },
    });
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      ...sarasResourceLoaderOptions({
        session: options.session,
        turn: options.turnContext,
        router,
      }),
    });
    await resourceLoader.reload();

    const customTools = options.tools.map((tool) => toPiTool(tool, ai));
    const first = modelRuntime.getModel(this.provider, router.fast[0] ?? router.strong[0] ?? '');
    const { session } = await pi.createAgentSession({
      cwd: options.cwd,
      agentDir: options.agentDir,
      ...(first && { model: first }),
      thinkingLevel: 'off',
      modelRuntime,
      resourceLoader,
      // Allowlist = the App Tools and the extension's tools. Built-in tools stay off.
      tools: [...options.tools.map((t) => t.name), ...SARAS_TOOL_NAMES],
      noTools: 'all',
      customTools: customTools as never,
      sessionManager,
      settingsManager,
    });
    // ctx.ui for the extension: ask_user's select becomes question.asked (no live person here).
    await session.bindExtensions({
      uiContext: createQuestionBridge(options.onQuestion),
      mode: 'rpc',
    });
    const auto = modelRuntime.getModel(VIRTUAL_PROVIDER, VIRTUAL_MODEL_ID);
    if (
      auto &&
      !(session.model?.provider === VIRTUAL_PROVIDER && session.model.id === VIRTUAL_MODEL_ID)
    ) {
      await session.setModel(auto);
    }

    const queue = (how: 'steer' | 'followUp') => (text: string, o?: { expand?: boolean }) =>
      o?.expand
        ? session.prompt(text, { expandPromptTemplates: true, streamingBehavior: how })
        : how === 'steer'
          ? session.steer(text)
          : session.followUp(text);

    return {
      subscribe: (listener) => session.subscribe(listener as (event: unknown) => void),
      prompt: (text, o) => session.prompt(text, { expandPromptTemplates: o?.expand === true }),
      steer: async (text, o) => void (await queue('steer')(text, o)),
      followUp: async (text, o) => void (await queue('followUp')(text, o)),
      abort: () => session.abort(),
      compact: async () => {
        // The extension's session_before_compact hook adds the Saras summary instructions.
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

export type { HarnessEvent };
