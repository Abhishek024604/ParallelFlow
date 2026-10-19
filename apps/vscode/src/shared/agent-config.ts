// What the VS Code side hands saras-agent (the Saras Pi extension) through SARAS_AGENT_CONFIG, and
// how the model tiers from GET /v1/llm/models become the `saras/auto` router. No secrets in here.

/** The provider saras-guard registers for the Saras LLM proxy (saras/auto routes inside it). */
export const SARAS_PROVIDER = 'saras';
/** The router's model id: `--provider saras --model auto`. */
export const AUTO_MODEL = 'auto';

export type ModelTier = 'fast' | 'strong' | 'fallback';

export interface AgentRouter {
  fast: string[];
  strong: string[];
  fallbacks: string[];
}

export interface AgentConfig {
  agentName: string;
  /** The linked arena's name and description, when the folder is linked. */
  arenaBrief?: string;
  /** Unset: no routing (one model picked by saras.model). */
  router?: AgentRouter;
}

/** The router from the proxy's model list, or undefined when it names no strong or fast model. */
export function routerFrom(
  models: readonly { id: string; tier?: ModelTier }[],
): AgentRouter | undefined {
  const of = (tier: ModelTier) => models.filter((m) => m.tier === tier).map((m) => m.id);
  const fast = of('fast');
  const strong = of('strong');
  if (!fast.length && !strong.length) return undefined;
  return {
    fast: fast.length ? fast : strong,
    strong: strong.length ? strong : fast,
    fallbacks: of('fallback'),
  };
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];

/** Lenient: a bad or missing config still gives a working agent (no routing, default name). */
export function parseAgentConfig(raw: string | undefined): AgentConfig {
  let v: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') v = parsed as Record<string, unknown>;
  } catch {
    // default config below
  }
  const name = typeof v.agentName === 'string' && v.agentName.trim() ? v.agentName.trim() : 'AI';
  const brief = typeof v.arenaBrief === 'string' && v.arenaBrief.trim() ? v.arenaBrief : undefined;
  const r = v.router as Record<string, unknown> | undefined;
  const fast = strings(r?.fast);
  const strong = strings(r?.strong);
  const router =
    fast.length || strong.length
      ? {
          fast: fast.length ? fast : strong,
          strong: strong.length ? strong : fast,
          fallbacks: strings(r?.fallbacks),
        }
      : undefined;
  return {
    agentName: name.slice(0, 60),
    ...(brief && { arenaBrief: brief.slice(0, 4000) }),
    ...(router && { router }),
  };
}

/**
 * The coder profile's skills and slash commands (packages/pi-saras PROFILE_SKILLS / PROFILE_COMMANDS
 * `coder`; a unit test keeps them equal). Listed here because the extension host bundle cannot load
 * pi-saras, whose resource paths come from import.meta.url.
 */
export const CODER_SKILLS = ['review-pr', 'test-plan'] as const;
export const CODER_COMMANDS = ['review'] as const;

/** The linked arena as the agent's <arena_brief>. */
export function arenaBrief(arena: {
  name: string;
  cycle?: number | null;
  stage?: string | null;
}): string {
  return arena.cycle
    ? `${arena.name}: cycle ${arena.cycle}, stage ${arena.stage ?? '?'}`
    : arena.name;
}
