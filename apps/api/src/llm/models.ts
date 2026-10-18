// Which models the LLM proxy may call (ADR-037). The same list the agent runtime uses: RUNTIME_MODEL
// then RUNTIME_FALLBACK_MODELS, with the same defaults. Copied from apps/runtime/src/config.ts (apps
// never import each other); keep the two in step.

/** A strong general assistant on OpenRouter (id format: <vendor>/<model>). */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

/** Tried in order after the primary model when it is overloaded or rate limited. */
export const DEFAULT_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

/** The primary model, then its fallbacks (no duplicates). */
export function allowedModels(env: NodeJS.ProcessEnv): string[] {
  const list = (raw: string) =>
    raw
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  const primary = list(env.RUNTIME_MODEL ?? '');
  const fallbacks =
    env.RUNTIME_FALLBACK_MODELS === undefined
      ? DEFAULT_FALLBACK_MODELS
      : list(env.RUNTIME_FALLBACK_MODELS);
  return [...new Set([...(primary.length ? primary : [DEFAULT_MODEL]), ...fallbacks])];
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
  return status === 429 || status === 503;
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
