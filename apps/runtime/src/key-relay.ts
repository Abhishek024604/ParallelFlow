// The key pool in front of Pi (OPENROUTER_API_KEYS): Pi's OpenRouter provider is pointed at this
// relay on 127.0.0.1, which sends each request on to OpenRouter with the next key that is not
// rate limited (runtime-client key-pool.ts) and streams the answer back. Pi only holds a stand-in
// key. Bodies, prompts and keys are never logged: only a key's position in the pool.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Logger } from '@parallelflow/observability';
import { type KeyPool, poolFetch } from '@parallelflow/runtime-client';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
/** What Pi sends as its key: the relay replaces it. */
export const RELAY_KEY = 'parallelflow-key-pool';

/** Request headers passed on (the rest, including Pi's stand-in authorization, are dropped). */
const PASS = ['content-type', 'accept', 'http-referer', 'x-title', 'user-agent'];

export interface KeyRelay {
  /** The base URL to give Pi's OpenRouter provider. */
  url: string;
  close(): Promise<void>;
}

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startKeyRelay(
  pool: KeyPool,
  logger: Logger,
  upstream = OPENROUTER_API,
  base: typeof fetch = globalThis.fetch,
): Promise<KeyRelay> {
  const send = poolFetch(pool, base, {
    onRest: ({ index, status, ms, available }) =>
      logger.info(
        { key: index + 1, status, restSeconds: Math.round(ms / 1000), available },
        'AI key resting; using the next one',
      ),
  });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    try {
      const path = (req.url ?? '/').replace(/^\/v1/, '');
      const headers = new Headers();
      for (const name of PASS) {
        const v = req.headers[name];
        if (typeof v === 'string') headers.set(name, v);
      }
      const payload = req.method === 'GET' || req.method === 'HEAD' ? undefined : await body(req);
      const answer = await send(`${upstream}${path}`, {
        method: req.method ?? 'GET',
        headers,
        ...(payload && { body: payload }),
        signal: abort.signal,
      });
      const out: Record<string, string> = { 'cache-control': 'no-store' };
      const type = answer.headers.get('content-type');
      if (type) out['content-type'] = type;
      res.writeHead(answer.status, out);
      if (!answer.body) {
        res.end();
        return;
      }
      Readable.fromWeb(answer.body as unknown as WebReadableStream<Uint8Array>)
        .on('error', () => res.destroy())
        .pipe(res);
    } catch (err) {
      if (abort.signal.aborted) return;
      logger.warn(
        { err: err instanceof Error ? err.name : 'Error' },
        'AI key relay: upstream failed',
      );
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'The AI provider could not be reached.' } }));
      } else res.destroy();
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
