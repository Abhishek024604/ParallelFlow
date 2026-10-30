// What the VS Code side hands parallelflow-agent (the ParallelFlow Pi extension) through PARALLELFLOW_AGENT_CONFIG, and
// how the model tiers from GET /v1/llm/models become the `parallelflow/auto` router. No secrets in here.

/** The provider parallelflow-guard registers for the ParallelFlow LLM proxy (parallelflow/auto routes inside it). */
export const PARALLELFLOW_PROVIDER = 'parallelflow';
/** The router's model id: `--provider parallelflow --model auto`. */
export const AUTO_MODEL = 'auto';
/** Pi's built-in Anthropic provider, used with the person's own Claude subscription token. */
export const CLAUDE_PROVIDER = 'anthropic';
/** `parallelflow.modelSource`: the ParallelFlow LLM proxy, or the person's Claude Pro/Max subscription. */
export type ModelSource = 'parallelflow' | 'claude';

/** The router over Claude models when the agent runs on the person's Claude subscription. */
export const CLAUDE_ROUTER: AgentRouter = {
  fast: ['claude-haiku-4-5'],
  strong: ['claude-sonnet-5-5'],
  fallbacks: ['claude-sonnet-4-6'],
};

export type ModelTier = 'fast' | 'strong' | 'fallback';

/** What the agent works as: the coding agent, or SWA (the software architect, packages/pi-swa). */
export type AgentMode = 'coder' | 'architect';

export interface AgentRouter {
  fast: string[];
  strong: string[];
  fallbacks: string[];
}

export interface AgentConfig {
  agentName: string;
  /** The linked arena's name and description, when the folder is linked. */
  arenaBrief?: string;
  /** Unset: no routing (one model picked by parallelflow.model). */
  router?: AgentRouter;
  /** The provider the router's models are on. Unset: parallelflow (the ParallelFlow LLM proxy). */
  provider?: typeof PARALLELFLOW_PROVIDER | typeof CLAUDE_PROVIDER;
  /** Unset: coder. */
  mode?: AgentMode;
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
  const mode: AgentMode | undefined = v.mode === 'architect' ? 'architect' : undefined;
  const provider = v.provider === CLAUDE_PROVIDER ? CLAUDE_PROVIDER : undefined;
  return {
    agentName: name.slice(0, 60),
    ...(mode && { mode }),
    ...(provider && { provider }),
    ...(brief && { arenaBrief: brief.slice(0, 4000) }),
    ...(router && { router }),
  };
}

/**
 * The coder profile's skills and slash commands (packages/pi-parallelflow PROFILE_SKILLS / PROFILE_COMMANDS
 * `coder`; a unit test keeps them equal). Listed here because the extension host bundle cannot load
 * pi-parallelflow, whose resource paths come from import.meta.url.
 */
export const CODER_SKILLS = ['review-pr', 'test-plan'] as const;
export const CODER_COMMANDS = ['review'] as const;

/**
 * How the coding agent works in an arena repo: equal to packages/pi-parallelflow CODER_REPO_RULES (part
 * of the coder system prompt; a unit test keeps them equal). The task prompt repeats them so the
 * agent's first step is reading AGENTS.md, the architecture and the story.
 */
export const CODER_REPO_RULES = [
  '- Before you code, read AGENTS.md (and AGENTS.local.md if present), then the design principles in docs/design/architecture/ (stack.md, model.yaml, decisions/ADR-*.md and the LLD under lld/ of each component you touch), then the story you are implementing (docs/plan/requirements-story-*.md or docs/product/backlog/STORY-*.md). Follow AGENTS.md; where it and these rules disagree, these rules win.',
  '- Work only on the current task branch. Never switch to, commit to or touch the default branch (main), never push, never merge, never rewrite history. The person pushes and opens the pull request.',
  '- Implement with tests, in small conventional commits (feat:, fix:, test:, docs:, refactor:) as you go (git add + git commit).',
  '- When you finish, report which stories (STORY-…), ADRs and components (CMP-…) you implemented or followed, and which docs you read.',
] as const;

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

/**
 * The `claude setup-token` token in what the person pasted. Terminal copies often carry line breaks
 * or spaces where the long token wrapped, quotes, or the text around it, so all whitespace is dropped
 * and the token is picked out.
 */
export function claudeTokenFrom(pasted: string): { token: string } | { error: string } {
  const text = pasted.replace(/\s+/g, '');
  const token = /sk-ant-oat[\w.-]+/.exec(text)?.[0];
  if (token && token.length >= 40) return { token };
  if (/sk-ant-api/.test(text)) {
    return {
      error:
        'That is an Anthropic API key (billed per use), not a subscription token. Run `claude setup-token` for one.',
    };
  }
  return token
    ? { error: 'That token looks cut short. Copy the whole token printed by `claude setup-token`.' }
    : {
        error:
          'No Claude subscription token found. Paste the token `claude setup-token` prints (it starts with sk-ant-oat).',
      };
}
