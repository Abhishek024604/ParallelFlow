// OpenRouter's live model catalog (GET /api/v1/models, public, no key). Pi ships a bundled
// OpenRouter model list, so a model released after that build is unknown to it and would be
// skipped. For configured ids Pi does not know, the runtime reads their limits from here and adds
// them to Pi's OpenRouter provider through a generated models.json. Copied in apps/api
// (llm/openrouter-catalog.ts); apps never import each other, so keep the two in step.

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  /** The model refuses requests with reasoning turned off. */
  reasoningRequired: boolean;
}

/** The catalog entries for `ids`, from the `GET /models` body. Unknown ids are left out. */
export function parseCatalog(body: unknown, ids: readonly string[]): CatalogModel[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const wanted = new Set(ids);
  const out: CatalogModel[] = [];
  for (const raw of data) {
    const m = raw as Record<string, unknown>;
    if (typeof m.id !== 'string' || !wanted.has(m.id)) continue;
    const top = (m.top_provider ?? {}) as Record<string, unknown>;
    const contextWindow = positive(m.context_length) ?? positive(top.context_length) ?? 128_000;
    const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    out.push({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      contextWindow,
      maxTokens: Math.min(positive(top.max_completion_tokens) ?? 16_384, contextWindow),
      reasoning: params.includes('reasoning'),
      reasoningRequired: (m.reasoning as { mandatory?: unknown } | undefined)?.mandatory === true,
    });
  }
  return out;
}

/** The catalog entries for `ids`; [] when OpenRouter cannot be reached in time. */
export async function fetchCatalog(
  ids: readonly string[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = 10_000,
): Promise<CatalogModel[]> {
  if (!ids.length) return [];
  try {
    const res = await fetchFn(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? parseCatalog(await res.json(), ids) : [];
  } catch {
    return [];
  }
}

/** A Pi models.json that adds `models` to the built-in OpenRouter provider (its API and URL). */
export function piModelsJson(models: readonly CatalogModel[], baseUrl?: string): string {
  return JSON.stringify({
    providers: {
      openrouter: {
        // The key relay (key-relay.ts) when the runtime has a pool of keys.
        ...(baseUrl && { baseUrl }),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          // As Pi's bundled OpenRouter models have it.
          compat: { supportsDeveloperRole: false, thinkingFormat: 'openrouter' },
        })),
      },
    },
  });
}

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}
