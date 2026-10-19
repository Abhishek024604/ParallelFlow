import { readFileSync } from 'node:fs';
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  SessionBeforeCompactEvent,
} from '@earendil-works/pi-coding-agent';
import { autonomyDecision, DRAFT_TOOLS } from './autonomy.js';
import { compactionInstructions } from './compaction.js';
import {
  checkConnectorCall,
  type ConnectorLaunch,
  dropConnectorArgs,
  mcpServerConfig,
  parseMcpToolName,
} from './connectors.js';
import {
  appToolName,
  preamble,
  renderSections,
  type SarasSessionContext,
  type SarasTurnContext,
  type SkillListing,
} from './context.js';
import { cleanAssistantContent, contentText, type SavedDraft } from './guardrails.js';
import {
  ASK_USER,
  ASK_USER_DESCRIPTION,
  ASK_USER_PARAMETERS,
  askThroughUi,
  parseAsk,
} from './questions.js';
import { readFrontmatter } from './resources.js';
import { chainFor, isCapacityError, route, type RouterConfig, type RouterState } from './router.js';

// The Saras Pi extension. One factory call per Pi session: every piece of state below lives in the
// closure of that call, so two sessions (two arenas, an arena and a private chat) never share
// anything. The host passes plain data (session context, a per-turn getter, the router config).
//
//   before_agent_start  → system prompt sections (identity, how to work, house rules, arena brief,
//                          team, cycle, autonomy, bridge snapshot, skills, this turn's context)
//   tool_call           → autonomy layer 1 (blocks what the turn's policy forbids)
//   tool_result         → remembers the documents the run saved (for the paste guard)
//   message_end         → the finalized assistant message, cleaned (ids, secrets, tool names) and
//                          without a pasted copy of a saved document
//   session_before_compact → Pi's compaction with Saras instructions (keep decisions, owners, open
//                          questions, stage, document names), on the strong model chain
//   ask_user, load_skill → model-callable tools (questions via ctx.ui; skill instructions)
//   saras/auto          → the virtual model that routes each request (router.ts)

export const VIRTUAL_PROVIDER = 'saras';
export const VIRTUAL_MODEL_ID = 'auto';
export const LOAD_SKILL = 'load_skill';
/** The extension's tools: hosts that pass a tool allowlist to Pi must include these. */
export const SARAS_TOOL_NAMES = [ASK_USER, LOAD_SKILL] as const;

/** The models `saras/auto` routes to, all on one physical provider (e.g. openrouter). */
export interface SarasRouterOptions extends RouterConfig {
  provider: string;
  /** Limits shown before the first response. */
  contextWindow?: number;
  maxTokens?: number;
}

export interface SarasExtensionOptions {
  session: SarasSessionContext;
  /** The running turn's data (read when each agent run starts and on tool calls). */
  turn?: () => SarasTurnContext | undefined;
  /** Registers `saras/auto`. Without it the host picks the model itself. */
  router?: SarasRouterOptions;
  /** Custom compaction instructions (default on). */
  compaction?: boolean;
  /**
   * External MCP servers for this session (connectors.ts), registered with Pi's MCP client. The host
   * must load Pi's MCP extension next to this one and allow their tool names.
   */
  connectors?: readonly ConnectorLaunch[];
  /** Register the ask_user tool (default on). Off when the host has its own (VS Code's guard). */
  askUser?: boolean;
  /**
   * Clean finalized replies (ids, secrets, tool names, pasted documents; default on). Off for the
   * coding agent, whose replies talk about code and are never posted to an arena.
   */
  cleanOutput?: boolean;
  /**
   * Pi's compact() and TypeBox `Type`, loaded from the SDK by dynamic import by default. A host that
   * loads this extension through Pi's extension loader passes them in (it resolves only static
   * imports to Pi's own modules). Also a test seam.
   */
  compact?: typeof import('@earendil-works/pi-coding-agent').compact;
  typebox?: typeof import('@earendil-works/pi-ai').Type;
}

/** The text of the latest user message in a request. */
function lastUserText(messages: readonly { role: string; content?: unknown }[]): {
  text: string;
  toolResults: number;
} {
  let toolResults = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'toolResult') toolResults += 1;
    if (m.role === 'user') return { text: contentText(m.content), toolResults };
  }
  return { text: '', toolResults };
}

/** Documents saved by draft tool calls inside one assistant message (before they ran). */
function draftCalls(content: unknown): SavedDraft[] {
  if (!Array.isArray(content)) return [];
  const drafts: SavedDraft[] = [];
  for (const part of content as { type?: string; name?: string; arguments?: unknown }[]) {
    if (part?.type !== 'toolCall' || !part.name) continue;
    if (!DRAFT_TOOLS.has(appToolName(part.name))) continue;
    const args = (part.arguments ?? {}) as Record<string, unknown>;
    if (typeof args['content'] !== 'string' || typeof args['name'] !== 'string') continue;
    drafts.push({
      name: args['name'].trim(),
      content: args['content'],
      update: typeof args['artifact_id'] === 'string',
    });
  }
  return drafts;
}

const sameState = (a: RouterState | undefined, b: RouterState): boolean =>
  !!a && a.tier === b.tier && a.job === b.job;

/** Builds the extension factory for one session. */
export function createSarasExtension(options: SarasExtensionOptions): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    const Type = options.typebox ?? (await import('@earendil-works/pi-ai')).Type;
    const turn = options.turn ?? (() => undefined);

    // Per-session state (this closure only).
    let skills: { listing: SkillListing; file: string; dir: string }[] = [];
    let drafts: SavedDraft[] = [];

    pi.on('before_agent_start', (event) => {
      skills = event.systemPromptOptions.skills
        .filter((s) => !s.disableModelInvocation)
        .map((s) => ({
          listing: { name: s.name, description: s.description },
          file: s.filePath,
          dir: s.baseDir,
        }));
      drafts = [];
      const opts = event.systemPromptOptions;
      // The coding agent keeps Pi's own system prompt (its tools, how to edit files).
      if (options.session.profile !== 'coder') opts.customPrompt = preamble(options.session);
      Object.assign(
        opts.sections,
        renderSections(
          options.session,
          turn(),
          skills.map((s) => s.listing),
        ),
      );
    });

    const connectors = (options.connectors ?? []).map((l) => l.connector);
    for (const launch of options.connectors ?? []) {
      pi.registerMcpServer(launch.connector.name, mcpServerConfig(launch));
    }

    pi.on('tool_call', (event) => {
      if (event.toolName === ASK_USER || event.toolName === LOAD_SKILL) return;
      const connector = checkConnectorCall(event.toolName, connectors);
      if (connector.kind === 'blocked') return { block: true, reason: connector.reason };
      if (connector.kind === 'allowed') {
        const decision = autonomyDecision(
          `${connector.connector.name}.${connector.tool}`,
          turn()?.autonomy,
          connector.autonomyClass,
        );
        if (decision.block) return { block: true, reason: decision.reason };
        dropConnectorArgs(connector.connector, connector.tool, event.input);
        return;
      }
      const decision = autonomyDecision(appToolName(event.toolName), turn()?.autonomy);
      if (decision.block) return { block: true, reason: decision.reason };
    });

    pi.on('tool_result', (event) => {
      if (event.isError) return;
      const mcp = parseMcpToolName(event.toolName);
      if (mcp) {
        const clean = connectors.find((c) => c.name === mcp.server)?.cleanResult;
        if (!clean) return;
        return {
          content: event.content.map((part) =>
            part.type === 'text' ? { ...part, text: clean(mcp.tool, part.text) } : part,
          ),
        };
      }
      const tool = appToolName(event.toolName);
      if (!DRAFT_TOOLS.has(tool) || tool.startsWith('tasks.') || tool.startsWith('delegation.')) {
        return;
      }
      const name = event.input['name'];
      const content = event.input['content'];
      if (typeof name !== 'string' || typeof content !== 'string') return;
      drafts = [
        ...drafts.filter((d) => d.name !== name.trim()),
        { name: name.trim(), content, update: typeof event.input['artifact_id'] === 'string' },
      ];
    });

    if (options.cleanOutput !== false) {
      pi.on('message_end', (event) => {
        const message = event.message as { role: string; content?: unknown };
        if (message.role !== 'assistant') return;
        const known = [...drafts, ...draftCalls(message.content)];
        const content = cleanAssistantContent(message.content, known);
        if (!content) return;
        return { message: { ...event.message, content } as typeof event.message };
      });
    }

    if (options.compaction !== false) {
      pi.on('session_before_compact', async (event, ctx) => customCompaction(event, ctx, options));
    }

    if (options.askUser !== false)
      pi.registerTool({
        name: ASK_USER,
        label: 'Ask',
        description: ASK_USER_DESCRIPTION,
        parameters: Type.Unsafe<Record<string, unknown>>(ASK_USER_PARAMETERS),
        executionMode: 'sequential',
        execute: async (_id, params, signal, _onUpdate, ctx) => {
          const ask = parseAsk(params);
          if ('error' in ask) throw new Error(`INVALID_ARGS: ${ask.error}`);
          const outcome = await askThroughUi(ctx.ui, ask, signal);
          return {
            content: [{ type: 'text', text: outcome.text }],
            details: { waiting: outcome.waiting },
            terminate: outcome.waiting,
          };
        },
      });

    pi.registerTool({
      name: LOAD_SKILL,
      label: 'Skill',
      description:
        'Load the full instructions of one of your skills (listed in <saras_skills>) before doing that kind of work.',
      parameters: Type.Unsafe<{ name: string }>({
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
        additionalProperties: false,
      }),
      execute: async (_id, params) => {
        const name = String((params as { name?: unknown }).name ?? '').trim();
        const skill = skills.find((s) => s.listing.name === name);
        if (!skill) {
          throw new Error(
            `NOT_FOUND: no skill named "${name}". Available: ${skills.map((s) => s.listing.name).join(', ') || 'none'}`,
          );
        }
        const body = readFrontmatter(readFileSync(skill.file, 'utf8')).body.trim();
        return {
          content: [
            { type: 'text', text: `<skill name="${skill.listing.name}">\n${body}\n</skill>` },
          ],
          details: { skill: skill.listing.name },
        };
      },
    });

    const router = options.router;
    if (router) {
      pi.registerVirtualModel<RouterState>({
        provider: VIRTUAL_PROVIDER,
        id: VIRTUAL_MODEL_ID,
        name: 'Saras auto',
        thinkingLevels: ['off', 'low', 'medium', 'high'],
        contextWindow: router.contextWindow ?? 128_000,
        maxTokens: router.maxTokens ?? 16_384,
        input: ['text'],
        route(request, ctx) {
          const find = (id: string) => {
            const model = ctx.modelRegistry.find(router.provider, id);
            return model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
          };
          const { text, toolResults } = lastUserText(request.messages);
          const job = turn()?.job;
          const decision = route(
            {
              reason: request.reason,
              text,
              ...(job && { job }),
              toolResults,
              ...(request.previous?.model.provider === router.provider && {
                previous: request.previous.model.id,
              }),
              ...(request.failed && {
                failed: {
                  model: request.failed.model.id,
                  ...(request.failed.message.errorMessage && {
                    error: request.failed.message.errorMessage,
                  }),
                },
              }),
              ...(request.state && { state: request.state }),
            },
            router,
            (id) => !!find(id),
          );
          const model = find(decision.model);
          if (!model) throw new Error('No AI model is available right now');
          return {
            model,
            thinkingLevel: decision.thinkingLevel,
            state: sameState(request.state, decision.state) ? request.state : decision.state,
          };
        },
      });
    }
  };
}

/** Pi's own compaction summary, with Saras instructions, tried down the strong model chain. */
async function customCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  options: SarasExtensionOptions,
) {
  const router = options.router;
  const candidates = router
    ? chainFor('strong', router)
        .map((id) => ctx.modelRegistry.find(router.provider, id))
        .filter((m) => m !== undefined && ctx.modelRegistry.hasConfiguredAuth(m))
    : ctx.model && ctx.model.provider !== VIRTUAL_PROVIDER
      ? [ctx.model]
      : [];
  if (!candidates.length) return undefined;
  const compact = options.compact ?? (await import('@earendil-works/pi-coding-agent')).compact;
  const instructions = compactionInstructions(event.customInstructions);
  for (const candidate of candidates.slice(0, 3)) {
    if (!candidate || event.signal.aborted) break;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(candidate);
    if (!auth.ok) continue;
    const model = auth.baseUrl ? { ...candidate, baseUrl: auth.baseUrl } : candidate;
    try {
      const compaction = await compact(
        event.preparation,
        model,
        auth.apiKey,
        auth.headers as Record<string, string> | undefined,
        instructions,
        event.signal,
      );
      return { compaction };
    } catch (err) {
      if (!isCapacityError(err instanceof Error ? err.message : undefined)) break;
    }
  }
  return undefined; // Pi's default compaction runs instead.
}
