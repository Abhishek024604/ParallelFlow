import { describe, expect, it } from 'vitest';
import {
  APP_TOOLS_AUDIENCE,
  HttpRuntimeClient,
  mintToolToken,
  parseSse,
  RUNTIME_AUDIENCE,
  type RuntimeEvent,
  serviceToken,
  verifyJwt,
} from './index.js';

const KEY = 'k'.repeat(40);
const enc = new TextEncoder();

async function* chunks(...parts: string[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield enc.encode(part);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

const event = (seq: number, type: RuntimeEvent['type'], data?: object): string =>
  `id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify({ seq, type, turn_id: 't', session_id: 's', at: '2026-10-16T00:00:00Z', data })}\n\n`;

describe('parseSse', () => {
  it('parses frames split across chunks, CRLF, comments and multi-line data', async () => {
    const frames = await collect(
      parseSse(
        chunks(': hi\r\nid: 1\r\nevent: a\r\nda', 'ta: x\r\ndata: y\r\n\r\n', 'data: z\n\n'),
      ),
    );
    expect(frames).toEqual([
      { id: '1', event: 'a', data: 'x\ny' },
      { id: '1', event: 'message', data: 'z' },
    ]);
  });

  it('drops an unterminated final frame', async () => {
    expect(await collect(parseSse(chunks('data: a\n\ndata: b')))).toEqual([
      { event: 'message', data: 'a' },
    ]);
  });
});

describe('HttpRuntimeClient.streamTurnEvents', () => {
  it('resumes with Last-Event-ID after a dropped stream and stops at a terminal event', async () => {
    const seen: (string | null)[] = [];
    let call = 0;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push(headers.get('last-event-id'));
      expect(headers.get('authorization')).toMatch(/^Bearer /);
      call += 1;
      const body =
        call === 1
          ? event(1, 'turn.started') + event(2, 'message.delta', { text: 'He' })
          : event(3, 'message.delta', { text: 'llo' }) + event(4, 'turn.completed', {});
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const client = new HttpRuntimeClient({
      baseUrl: 'http://rt/v1',
      jwtKey: KEY,
      fetch: fakeFetch,
      reconnectDelayMs: 1,
    });
    const events = await collect(client.streamTurnEvents('s', 't'));
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(seen).toEqual([null, '2']);
  });
});

describe('JWTs', () => {
  it('service token: aud parallelflow-runtime, 60 s', () => {
    const now = 1_800_000_000_000;
    const claims = verifyJwt(serviceToken(KEY, now), KEY, RUNTIME_AUDIENCE, now / 1000);
    expect(claims['aud']).toBe('parallelflow-runtime');
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(60);
  });

  it('tool token: scoped claims, exp capped at 60 min, rejects a wrong key', () => {
    const now = 1_800_000_000_000;
    const t = mintToolToken(
      {
        sessionKey: 'org/o/project/p/arena',
        orgId: 'o',
        projectId: 'p',
        principal: { type: 'agent', id: 'a', kind: 'central' },
        scopes: ['arena.read_history'],
        ttlS: 99_999,
      },
      KEY,
      'http://tools/mcp',
      now,
    );
    expect(t.mcp_url).toBe('http://tools/mcp');
    const claims = verifyJwt(t.token, KEY, APP_TOOLS_AUDIENCE, now / 1000);
    expect(claims).toMatchObject({
      session_key: 'org/o/project/p/arena',
      org_id: 'o',
      project_id: 'p',
      principal: { type: 'agent', id: 'a', kind: 'central' },
      scopes: ['arena.read_history'],
    });
    expect((claims['exp'] as number) - (claims['iat'] as number)).toBe(3600);
    expect(t.expires_at).toBe(new Date(now + 3_600_000).toISOString());
    expect(() => verifyJwt(t.token, 'x'.repeat(40), APP_TOOLS_AUDIENCE, now / 1000)).toThrow();
    expect(() => serviceToken('short')).toThrow(/RUNTIME_JWT_KEY/);
  });
});
