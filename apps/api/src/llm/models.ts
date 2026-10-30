// Which models the LLM proxy may call (ADR-037): the agent runtime's tiers, read from the same
// environment, with no built-in models. Copied from apps/runtime/src/config.ts (apps never import
// each other); keep the two in step. The VS Code agent's Pi routes between the tiers itself.
//   RUNTIME_MODEL set   → that one model for both tiers (forced), then the fallbacks
//   otherwise           → RUNTIME_MODEL_FAST / RUNTIME_MODEL_STRONG (an unset tier uses the other),
//                         then RUNTIME_FALLBACK_MODELS (unset = none)

export type ModelTier = 'fast' | 'strong' | 'fallback';

const list = (raw: string) =>
  raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

/** The tiers from the environment, as the runtime reads them. */
export function modelTiers(env: NodeJS.ProcessEnv): {
  fast: string[];
  strong: string[];
  fallbacks: string[];
} {
  const forced = list(env.RUNTIME_MODEL ?? '');
  const fallbacks = list(env.RUNTIME_FALLBACK_MODELS ?? '');
  if (forced.length) return { fast: forced, strong: forced, fallbacks };
  const fast = list(env.RUNTIME_MODEL_FAST ?? '');
  const strong = list(env.RUNTIME_MODEL_STRONG ?? '');
  return { fast: fast.length ? fast : strong, strong: strong.length ? strong : fast, fallbacks };
}

/** Every allowed model, strong first (the primary), then fast, then fallbacks (no duplicates). */
export function allowedModels(env: NodeJS.ProcessEnv): string[] {
  const t = modelTiers(env);
  return [...new Set([...t.strong, ...t.fast, ...t.fallbacks])];
}

/** Each allowed model's tier (a model in two tiers counts as the first: strong, then fast). */
export function tierOf(env: NodeJS.ProcessEnv): Record<string, ModelTier> {
  const t = modelTiers(env);
  const out: Record<string, ModelTier> = {};
  for (const [tier, ids] of [
    ['strong', t.strong],
    ['fast', t.fast],
    ['fallback', t.fallbacks],
  ] as const) {
    for (const id of ids) out[id] ??= tier;
  }
  return out;
}

/**
 * The models to try for a request, in order, or null when the model is not allowed. No model (or
 * the primary) gets the primary and then every fallback, like the runtime; any other allowed model
 * is tried alone.
 */
export function modelPlan(requested: unknown, models: readonly string[]): string[] | null {
  const primary = models[0];
  if (!primary) return null;
  if (requested === undefined || requested === null || requested === '' || requested === primary) {
    return [...models];
  }
  if (typeof requested !== 'string') return null;
  return models.includes(requested) ? [requested] : null;
}

/** Upstream answers after which the next model is tried (overloaded, rate limited). */
export function shouldFallBack(status: number): boolean {
  // 403/404: this model refuses or is gone (a key's own refusal never gets here: the pool moves on).
  return status === 429 || status === 503 || status === 403 || status === 404;
}

/**
 * OpenAI chat-completions fields passed upstream. Everything else is dropped, in particular
 * OpenRouter's `models` / `route` / `provider` / `plugins`, which would let a caller reach models or
 * paid features outside the allowlist.
 */
export const FORWARDED_FIELDS = [
  'messages',
  'stream',
  'stream_options',
  'temperature',
  'top_p',
  'top_k',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'response_format',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'repetition_penalty',
  'reasoning',
  'reasoning_effort',
] as const;

/** The upstream body for one model, or an error message for a request that is not acceptable. */
export function upstreamBody(
  body: unknown,
  model: string,
): { ok: true; body: Record<string, unknown> } | { ok: false; message: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'The request body must be a JSON object.' };
  }
  const input = body as Record<string, unknown>;
  const messages = input.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: '`messages` must be a non-empty array.' };
  }
  const out: Record<string, unknown> = { model };
  for (const field of FORWARDED_FIELDS) {
    if (input[field] !== undefined) out[field] = input[field];
  }
  return { ok: true, body: out };
}
