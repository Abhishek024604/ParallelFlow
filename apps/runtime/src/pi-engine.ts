import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ConnectorLaunch,
  connectorToolNames,
  createQuestionBridge,
  SARAS_TOOL_NAMES,
  type SarasRouterOptions,
  sarasResourceLoaderOptions,
  VIRTUAL_MODEL_ID,
  VIRTUAL_PROVIDER,
} from '@saras/pi-saras';
import { createSwaExtension, SWA_TOOL_NAMES, swaResources } from '@saras/pi-swa';
import {
  type AgentEngine,
  type AgentHandle,
  type AgentTool,
  type CreateAgentOptions,
  type HarnessEvent,
  ToolCallError,
} from './agent.js';
import { AppArchStore, ARENA_DOCUMENTS, PRIVATE_DOCUMENTS } from './swa-store.js';

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
//   - only the App Tools, the extension's two tools and SWA's swa_* tools are
//     enabled: Pi's built-in tools (read, write, edit, bash, …) never are. SWA reaches arch/ only
//     through this session's App Tools (swaFor, swa-store.ts);
//   - OpenRouter is the only provider; the key is set in memory (never written to disk);
//   - connectors (external MCP servers, packages/pi-saras connectors.ts) run through Pi's own MCP
//     client: one server process per session, started from this app's lockfile with an environment
//     built from nothing (connectors.ts), no mcp.json read, only the catalog's tools allowed.
//     Ephemeral forks get none.
// An ephemeral fork (summaries) reads the parent's session file into an in-memory session manager:
// nothing is written anywhere, so the parent's history is untouched.

type PiSdk = typeof import('@earendil-works/pi-coding-agent');
type PiAi = typeof import('@earendil-works/pi-ai');
type PiMcp = typeof import('@earendil-works/pi-mcp');
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
  /** Enabled connectors, resolved (connectors.ts). Each session gets those of its profile. */
  connectors?: readonly ConnectorLaunch[];
}

export class PiEngine implements AgentEngine {
  private pi: PiSdk | null = null;
  private ai: PiAi | null = null;
  private mcp: PiMcp | null = null;
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
    this.mcp = await importOptional<PiMcp>('@earendil-works/pi-mcp');
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

  private connectorsFor(options: CreateAgentOptions): ConnectorLaunch[] {
    if (!this.mcp) return [];
    return sessionConnectors(
      this.options.connectors ?? [],
      options.session.profile,
      options.ephemeral,
    );
  }

  /**
   * Pi's MCP client for this session's connectors: no mcp.json (the Saras extension registers each
   * server), and a stdio transport that inherits nothing from this process.
   */
  private mcpExtension(pi: PiSdk, connectors: readonly ConnectorLaunch[], agentDir: string) {
    const mcp = this.mcp;
    if (!mcp) throw new Error('Pi MCP is not loaded');
    const launches = new Map(connectors.map((l) => [l.connector.name, l]));
    return pi.createMcpExtension({
      loadConfig: () => ({ servers: [], errors: [] }),
      createTransport: (entry, cwd) => {
        const launch = launches.get(entry.name);
        if (!launch) throw new Error(`MCP server "${entry.name}" is not a Saras connector`);
        return new mcp.StdioTransport({
          command: launch.command,
          args: [...launch.args],
          // Its own folder: the sandbox does not let it read the session's.
          cwd: launch.cwd ?? cwd,
          env: { ...launch.env },
          inheritEnv: false,
          stderr: 'pipe',
        });
      },
      logPath: join(agentDir, 'mcp.log'),
    });
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
    const connectors = this.connectorsFor(options);
    const saras = sarasResourceLoaderOptions({
      session: options.session,
      turn: options.turnContext,
      router,
      connectors,
    });
    const swa = swaFor(options, ai);
    const resourceLoader = new pi.DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      ...saras,
      additionalSkillPaths: [...saras.additionalSkillPaths, ...(swa?.skills ?? [])],
      extensionFactories: [
        ...saras.extensionFactories,
        ...(swa ? [swa.extension] : []),
        ...(connectors.length ? [this.mcpExtension(pi, connectors, options.agentDir)] : []),
      ],
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
      // Allowlist = the App Tools, the extension's tools and the connectors' listed tools. Built-in
      // tools stay off.
      tools: [
        ...options.tools.map((t) => t.name),
        ...SARAS_TOOL_NAMES,
        ...(swa ? SWA_TOOL_NAMES : []),
        ...connectorToolNames(connectors.map((c) => c.connector)),
      ],
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
      // Like Pi's own session runtime: extensions hear session_shutdown first (Pi's MCP client
      // closes the connectors' server processes there), then the session goes.
      dispose: () => {
        void (async () => {
          try {
            const runner = session.extensionRunner;
            if (runner.hasHandlers('session_shutdown')) {
              await runner.emit({ type: 'session_shutdown', reason: 'quit' });
            }
          } catch {
            // Shutdown hooks must not keep the session alive.
          } finally {
            session.dispose();
          }
        })();
      },
    };
  }
}

/** How long "no arch/ documents here" is believed before asking App Tools again. */
const SWA_IDLE_RECHECK_MS = 60_000;

/**
 * SWA (packages/pi-swa) for an arena or a private chat: arch/ as that place's documents (the
 * arena's, or this chat's) through the session's own App Tools (swa-store.ts), the swa_* tools and
 * SWA's skills. There is no /swa extension command (pi-saras's /swa prompt template routes
 * instead), and approvals happen in the app: the arena owner's, or the chat owner's. Its rules join
 * the system prompt only for architecture work: a /swa run, or a place that already has arch/
 * documents. Ephemeral forks (summaries) get none.
 */
export function swaFor(
  options: Pick<CreateAgentOptions, 'session' | 'ephemeral' | 'tools'>,
  ai: Pick<PiAi, 'Type'>,
): { extension: ReturnType<typeof createSwaExtension>; skills: string[] } | null {
  if (options.ephemeral) return null;
  const documents =
    options.session.profile === 'central_arena'
      ? ARENA_DOCUMENTS
      : options.session.profile === 'personal_private'
        ? PRIVATE_DOCUMENTS
        : null;
  if (!documents) return null;
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  if (![documents.list.name, documents.read, documents.save].every((n) => tools.has(n))) {
    return null;
  }
  const store = new AppArchStore(async (name, args) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`UNAVAILABLE: the ${name} tool is not available here`);
    return tool.execute(args);
  }, documents);
  let hasArch = false;
  let checkedAt = -Infinity;
  return {
    skills: swaResources().skills,
    extension: createSwaExtension({
      store: () => store,
      command: false,
      guardFileTools: false,
      typebox: ai.Type,
      active: async (prompt, s) => {
        if (/\bSWA\b|\bswa_\w+|\barch\//.test(prompt)) return true;
        if (!hasArch && Date.now() - checkedAt > SWA_IDLE_RECHECK_MS) {
          checkedAt = Date.now();
          hasArch = (await s.list().catch(() => [])).length > 0;
        }
        return hasArch;
      },
    }),
  };
}

/** Connectors are on when Pi's MCP client loaded; forks (summaries) never get them. */
export function sessionConnectors(
  all: readonly ConnectorLaunch[],
  profile: string,
  ephemeral: boolean | undefined,
): ConnectorLaunch[] {
  if (ephemeral) return [];
  return all.filter((l) => (l.connector.profiles as readonly string[]).includes(profile));
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
