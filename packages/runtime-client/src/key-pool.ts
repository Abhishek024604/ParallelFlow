// A pool of OpenRouter keys (OPENROUTER_API_KEYS, plus OPENROUTER_API_KEY): each request uses the
// next key that is not resting, and a key the provider refuses (rate limit, no credits, revoked)
// rests until its limit resets, so the request is sent again with the next key. Keys are never
// logged or returned: callers see a key's position in the pool only.

/** A key rests this long after a 429 that says nothing about when its limit resets. */
const RATE_LIMIT_REST_MS = 60_000;
/** ...and this long after the provider refuses it (401 revoked, 402 no credits, 403). */
const REFUSED_REST_MS = 60 * 60_000;
const MAX_REST_MS = 24 * 60 * 60_000;

/** The configured keys: OPENROUTER_API_KEYS (comma, space or newline separated) then OPENROUTER_API_KEY. */
export function poolKeys(env: Record<string, string | undefined>): string[] {
  const listed = (env.OPENROUTER_API_KEYS ?? '').split(/[\s,;]+/);
  return [...new Set([...listed, env.OPENROUTER_API_KEY ?? ''].map((k) => k.trim()))].filter(
    (k) => k && !k.startsWith('#'),
  );
}

const MODEL_REFUSAL = /only available|not available|harness/i;

/** Statuses after which the same request goes again with another key. */
export function refusesKey(status: number): boolean {
  return status === 429 || status === 401 || status === 402 || status === 403;
}

/** How long a key rests after `status`, from the provider's reset headers when it sends them. */
export function restMs(
  status: number,
  headers: { get(name: string): string | null },
  now: number,
): number {
  if (status !== 429) return REFUSED_REST_MS;
  const clamp = (ms: number) => Math.min(Math.max(ms, 1000), MAX_REST_MS);
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    // OpenRouter sends epoch milliseconds; tolerate seconds.
    return clamp((reset < 1e12 ? reset * 1000 : reset) - now);
  }
  const after = Number(headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return clamp(after * 1000);
  return RATE_LIMIT_REST_MS;
}

export class KeyPool {
  private readonly restUntil: number[];
  private cursor = 0;

  constructor(
    private readonly keys: readonly string[],
    private readonly now: () => number = Date.now,
  ) {
    this.restUntil = keys.map(() => 0);
  }

  get size(): number {
    return this.keys.length;
  }

  /**
   * The next key that is not resting (round robin). When every key rests, the one that is free
   * soonest: limits are often per model, so the caller's next model may still work with it.
   */
  next(): { key: string; index: number } | null {
    if (!this.keys.length) return null;
    const now = this.now();
    for (let i = 0; i < this.keys.length; i += 1) {
      const index = (this.cursor + i) % this.keys.length;
      if ((this.restUntil[index] ?? 0) <= now) {
        this.cursor = (index + 1) % this.keys.length;
        return { key: this.keys[index] as string, index };
      }
    }
    const soonest = this.restUntil.indexOf(Math.min(...this.restUntil));
    return { key: this.keys[soonest] as string, index: soonest };
  }

  rest(index: number, ms: number): void {
    this.restUntil[index] = this.now() + ms;
  }

  /** Keys usable now. Safe to log. */
  get available(): number {
    const now = this.now();
    return this.restUntil.filter((t) => t <= now).length;
  }
}

export interface PoolFetchOptions {
  /** Told which key (by position) rests and for how long. Never given the key. */
  onRest?: (info: { index: number; status: number; ms: number; available: number }) => void;
}

/**
 * fetch with the pool's keys as the bearer token. A refused key rests and the request goes again
 * with the next one; when every key rests, the provider's last answer is returned as it is. The request body must be replayable (a string or bytes).
 */
export function poolFetch(
  pool: KeyPool,
  base: typeof fetch = globalThis.fetch,
  options: PoolFetchOptions = {},
): typeof fetch {
  return async (input, init) => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < pool.size; attempt += 1) {
      const picked = pool.next();
      if (!picked) break;
      const headers = new Headers(init?.headers);
      headers.set('authorization', `Bearer ${picked.key}`);
      const res = await base(input, { ...init, headers });
      if (!refusesKey(res.status)) return res;
      if (res.status === 403) {
        // A model this key may not use ("only available on …"): the model's refusal, not the key's.
        const text = await res.text().catch(() => '');
        if (MODEL_REFUSAL.test(text)) {
          return new Response(text, { status: res.status, headers: res.headers });
        }
      }
      const ms = restMs(res.status, res.headers, Date.now());
      pool.rest(picked.index, ms);
      options.onRest?.({ index: picked.index, status: res.status, ms, available: pool.available });
      if (pool.available === 0) return res;
      await res.body?.cancel().catch(() => undefined);
      last = res;
    }
    return (
      last ??
      new Response(
        JSON.stringify({
          error: { message: 'Every AI key is rate limited. Try again shortly.', code: 429 },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      )
    );
  };
}
