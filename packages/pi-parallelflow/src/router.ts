import type { ParallelFlowJob } from './context.js';

// The `parallelflow/auto` virtual model's routing (Pi `registerVirtualModel`): pure functions over plain
// data, so they are unit-tested without Pi. The extension adapts Pi's ModelRouteRequest to them.
//
//   user request    → FAST for quick conversational replies; STRONG for documents, specs, plans,
//                     code, summaries, reviews and long or tool-heavy requests
//   continuation    → stays on the model that handled the turn (prompt cache), except that a FAST
//                     turn that turns tool-heavy moves to STRONG once
//   retry           → the next model in the chain after the one that failed (overload, rate limit,
//                     5xx, timeouts); other errors retry on the same model
//   direct          → STRONG (compaction summaries and other one-off calls)
//
// Thinking level per job: chat off, documents/code/review high, summaries medium. Pi clamps it to
// what the chosen model supports.

export type Tier = 'fast' | 'strong';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high';

export interface RouterConfig {
  /** Quick replies, in order of preference. */
  fast: readonly string[];
  /** Documents, code, summaries, tool-heavy turns, in order of preference. */
  strong: readonly string[];
  /** Tried after both tiers, in order, on overload / rate limit. */
  fallbacks: readonly string[];
  /** Models that refuse a request with reasoning off (OpenRouter: reasoning.mandatory). */
  reasoningRequired?: readonly string[];
}

/** One request, as the router sees it. */
export interface RouteInput {
  reason: 'user' | 'continuation' | 'retry' | 'direct';
  /** The latest user message's text. */
  text: string;
  /** The turn's declared job, when the host knows it (slash commands, summaries). */
  job?: ParallelFlowJob;
  /** Tool results since the latest user message. */
  toolResults: number;
  /** Model id of the latest successful response in this conversation. */
  previous?: string;
  /** For a retry: the model that failed and its error text. */
  failed?: { model: string; error?: string };
  /** Router state stored on the session branch. */
  state?: RouterState;
}

export interface RouterState {
  tier: Tier;
  job: ParallelFlowJob;
}

export interface RouteDecision {
  model: string;
  thinkingLevel: ThinkingLevel;
  state: RouterState;
}

const STRONG_WORDS =
  /\b(spec|specification|prd|plan|planning|roadmap|design|architecture|document|doc|draft|write up|write-up|report|release notes|test plan|tests?|code|implement|refactor|function|bug|debug|review|summar(?:y|ise|ize)|analy[sz]e|compare|tasks?|break (?:it )?down|estimate|migration|schema|api)\b/i;
const CODE_HINT = /```|\b(?:function|class|const|import|SELECT|def)\b|=>|\{\s*\n/;
const CODE_WORDS =
  /\b(code|implement|refactor|function|bug|debug|stack trace|compile|regex|sql|typescript|javascript|python|endpoint|unit tests?)\b/i;
const SUMMARY_WORDS = /\b(summar(?:y|ise|ize)|recap|catch me up|what happened|state of)\b/i;
const REVIEW_WORDS = /\b(review|critique|feedback on|check (?:this|my))\b/i;
const DOC_WORDS =
  /\b(spec|prd|plan|roadmap|document|doc|draft|write up|write-up|report|release notes|test plan|tasks?)\b/i;
const LONG_REQUEST_CHARS = 600;
/** A FAST turn with this many tool results moves to STRONG. */
export const TOOL_HEAVY_RESULTS = 3;

/** The job a user request is, from the host's hint or the text. */
export function classify(text: string, job?: ParallelFlowJob): ParallelFlowJob {
  if (job) return job;
  if (SUMMARY_WORDS.test(text)) return 'summary';
  if (REVIEW_WORDS.test(text)) return 'review';
  if (CODE_HINT.test(text) || CODE_WORDS.test(text)) return 'code';
  if (DOC_WORDS.test(text)) return 'document';
  if (text.length > LONG_REQUEST_CHARS || STRONG_WORDS.test(text)) return 'document';
  return 'chat';
}

export const tierOf = (job: ParallelFlowJob): Tier => (job === 'chat' ? 'fast' : 'strong');

export const thinkingFor = (job: ParallelFlowJob): ThinkingLevel =>
  job === 'chat' ? 'off' : job === 'summary' ? 'medium' : 'high';

/** The ordered models to try for a tier: its own, then the other tier, then the fallbacks. */
export function chainFor(tier: Tier, config: RouterConfig): string[] {
  const own = tier === 'fast' ? config.fast : config.strong;
  const other = tier === 'fast' ? config.strong : config.fast;
  return [...new Set([...own, ...other, ...config.fallbacks])];
}

/** Errors worth moving to another model for (rather than retrying the same one). */
export function isCapacityError(error: string | undefined): boolean {
  if (!error) return true; // unknown: moving on is the safe bet for free models
  return /overload|rate.?limit|too many requests|\b429\b|\b5\d\d\b|unavailable|capacity|timeout|timed out|busy|quota|no endpoints|provider returned error/i.test(
    error,
  );
}

/**
 * Picks the physical model for one request. `available` filters ids the host can call (credentials,
 * catalogue); the first available model of the chain wins.
 */
export function route(
  input: RouteInput,
  config: RouterConfig,
  available: (id: string) => boolean = () => true,
): RouteDecision {
  const decision = pickRoute(input, config, available);
  // A model that cannot run with reasoning off gets the least reasoning instead.
  return decision.thinkingLevel === 'off' && config.reasoningRequired?.includes(decision.model)
    ? { ...decision, thinkingLevel: 'low' }
    : decision;
}

function pickRoute(
  input: RouteInput,
  config: RouterConfig,
  available: (id: string) => boolean,
): RouteDecision {
  const pick = (chain: readonly string[], from = 0): string | undefined =>
    chain.slice(from).find(available) ?? chain.find(available);

  if (input.reason === 'retry' && input.failed) {
    const state = input.state ?? { tier: 'strong', job: classify(input.text, input.job) };
    const chain = chainFor(state.tier, config);
    const at = chain.indexOf(input.failed.model);
    const model = isCapacityError(input.failed.error)
      ? pick(chain, at + 1)
      : available(input.failed.model)
        ? input.failed.model
        : pick(chain);
    return { model: model ?? input.failed.model, thinkingLevel: thinkingFor(state.job), state };
  }

  if (input.reason === 'continuation' && input.previous && input.state) {
    const state = input.state;
    if (state.tier === 'fast' && input.toolResults >= TOOL_HEAVY_RESULTS) {
      const strong: RouterState = {
        tier: 'strong',
        job: state.job === 'chat' ? 'document' : state.job,
      };
      const model = pick(chainFor('strong', config));
      if (model) return { model, thinkingLevel: thinkingFor(strong.job), state: strong };
    }
    if (available(input.previous)) {
      return { model: input.previous, thinkingLevel: thinkingFor(state.job), state };
    }
  }

  const job: ParallelFlowJob =
    input.reason === 'direct' ? (input.job ?? 'summary') : classify(input.text, input.job);
  const tier: Tier = input.reason === 'direct' ? 'strong' : tierOf(job);
  const chain = chainFor(tier, config);
  const model = pick(chain) ?? chain[0] ?? '';
  return { model, thinkingLevel: thinkingFor(job), state: { tier, job } };
}
