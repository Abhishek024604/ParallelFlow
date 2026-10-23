// OpenRouter's live model catalog (GET /api/v1/models, public, no key). The proxy's model list
// reports each allowed model's real context window and output limit from here, so the VS Code
// agent's Pi does not cap a model's answer at a guessed default (a model that thinks at length
// would run out before calling a tool). Copied from apps/runtime/src/openrouter-catalog.ts (apps
// never import each other); keep the two in step.

export const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
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

function positive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
}
