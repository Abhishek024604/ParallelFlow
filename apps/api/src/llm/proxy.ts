import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '@saras/observability';
import type { Response } from 'express';
import { modelPlan, shouldFallBack, upstreamBody } from './models.js';

// The LLM proxy for the VS Code extension (ADR-037): OpenAI-compatible chat completions forwarded
// to OpenRouter with the server's key, so no provider key lives on a laptop. This is the one place
// the API talks to a model provider (SLICE_DEBT). Request and response bodies, prompts and keys are
// never logged: only the model id, status and timing.

const OPENROUTER_URL = 'https://openrouter.ai/api/v1';

export interface LlmProxyOptions {
  /** OPENROUTER_API_KEY. Unset = the proxy answers 503. */
  apiKey?: string;
  /** Allowed models: primary first, then fallbacks (llm/models.ts). */
  models: string[];
  logger: Logger;
  baseUrl?: string;
  /** Tests inject a fake. */
  fetch?: typeof fetch;
  /** Shown to OpenRouter as the calling app. */
  referer?: string;
}

/** OpenAI-style error body. */
export function errorBody(message: string, code: string) {
  return { error: { message, type: code, code } };
}

export class LlmProxy {
  private readonly fetch: typeof fetch;

  constructor(private readonly options: LlmProxyOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  get configured(): boolean {
    return Boolean(this.options.apiKey);
  }

  /** GET /llm/models: the allowlist, OpenAI style. */
  models() {
    return {
      object: 'list' as const,
      data: this.options.models.map((id, i) => ({
        id,
        object: 'model' as const,
        owned_by: 'saras',
        default: i === 0,
      })),
    };
  }

  /** The request checks that run before the rate-limit commit; null = fine. */
  check(body: unknown): { status: number; body: ReturnType<typeof errorBody> } | null {
    if (!this.configured) {
      return {
        status: 503,
        body: errorBody('The AI is not configured on this Saras server.', 'not_configured'),
      };
    }
    const requested = (body as { model?: unknown } | null)?.model;
    if (!modelPlan(requested, this.options.models)) {
      return {
        status: 400,
        body: errorBody(
          `Model not allowed. Use one of: ${this.options.models.join(', ')}`,
          'model_not_allowed',
        ),
      };
    }
    const shaped = upstreamBody(body, this.options.models[0] ?? '');
    if (!shaped.ok) return { status: 400, body: errorBody(shaped.message, 'invalid_request') };
    return null;
  }

  /**
   * Forwards one request and writes the answer to `res` (JSON, or the SSE stream as it arrives).
   * The upstream call is aborted when the client goes away. Never throws.
   */
  async forward(body: unknown, res: Response): Promise<void> {
    const plan = modelPlan((body as { model?: unknown } | null)?.model, this.options.models) ?? [];
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    const started = Date.now();
    try {
      for (let i = 0; i < plan.length; i += 1) {
        const model = plan[i] as string;
        const shaped = upstreamBody(body, model);
        if (!shaped.ok) {
          res.status(400).json(errorBody(shaped.message, 'invalid_request'));
          return;
        }
        const upstream = await this.fetch(
          `${this.options.baseUrl ?? OPENROUTER_URL}/chat/completions`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.options.apiKey ?? ''}`,
              'content-type': 'application/json',
              accept: shaped.body.stream ? 'text/event-stream' : 'application/json',
              'x-title': 'Saras',
              ...(this.options.referer && { 'http-referer': this.options.referer }),
            },
            body: JSON.stringify(shaped.body),
            signal: abort.signal,
          },
        );
        const last = i === plan.length - 1;
        if (shouldFallBack(upstream.status) && !last) {
          await upstream.body?.cancel().catch(() => undefined);
          this.options.logger.info({ model, status: upstream.status }, 'llm proxy: falling back');
          continue;
        }
        await this.relay(upstream, res);
        this.options.logger.info(
          { model, status: upstream.status, ms: Date.now() - started },
          'llm proxy: done',
        );
        return;
      }
    } catch (err) {
      if (abort.signal.aborted) return;
      this.options.logger.warn(
        { err: err instanceof Error ? err.name : 'Error' },
        'llm proxy: upstream failed',
      );
      if (!res.headersSent) {
        res.status(502).json(errorBody('The AI provider could not be reached.', 'upstream_error'));
      } else {
        res.end();
      }
    } finally {
      res.off('close', onClose);
    }
  }

  private async relay(upstream: globalThis.Response, res: Response): Promise<void> {
    const type = upstream.headers.get('content-type') ?? 'application/json';
    res.status(upstream.status);
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    if (type.includes('text/event-stream')) {
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
    }
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
    await new Promise<void>((resolve, reject) => {
      stream.on('error', reject);
      res.on('close', resolve);
      stream.on('end', resolve);
      stream.pipe(res);
    });
  }
}
