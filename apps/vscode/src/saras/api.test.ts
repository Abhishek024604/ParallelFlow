import { describe, expect, it, vi } from 'vitest';
import { SarasApi, SarasApiError, SarasAuthError } from './api.js';

function api(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
  token: string | undefined = 'tok',
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  const onUnauthorized = vi.fn();
  const client = new SarasApi({
    baseUrl: 'http://saras.test/',
    getToken: async () => token || undefined,
    fetch,
    onUnauthorized,
  });
  return { client, fetch, onUnauthorized };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('SarasApi', () => {
  it('device code: validates the response and sends no token', async () => {
    const { client, fetch } = api(() =>
      json(200, {
        device_code: 'd',
        user_code: 'ABCD',
        verification_uri: 'http://saras.test/ext/device',
        verification_uri_complete: 'http://saras.test/ext/device?c=ABCD',
        expires_in: 600,
        interval: 5,
      }),
    );
    await expect(client.deviceCode('VS Code')).resolves.toMatchObject({ user_code: 'ABCD' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('http://saras.test/v1/ext/device/code');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(JSON.parse(init.body as string)).toEqual({ client_name: 'VS Code' });
  });

  it('device token: 200 token, 400 pending, other errors throw', async () => {
    const ok = api(() =>
      json(200, {
        access_token: 't',
        token_type: 'Bearer',
        expires_in: 60,
        user: { id: 'u', display_name: 'P', email: 'p@x' },
      }),
    );
    await expect(ok.client.deviceToken('d')).resolves.toMatchObject({ ok: true });
    const pending = api(() => json(400, { error: 'authorization_pending' }));
    await expect(pending.client.deviceToken('d')).resolves.toEqual({
      ok: false,
      error: 'authorization_pending',
    });
    const weird = api(() => json(400, { error: 'invalid_grant' }));
    await expect(weird.client.deviceToken('d')).rejects.toBeInstanceOf(SarasApiError);
    const badShape = api(() => json(200, { access_token: 't' }));
    await expect(badShape.client.deviceToken('d')).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('arenas: bearer token, validation and defaults', async () => {
    const { client, fetch } = api(() =>
      json(200, {
        items: [
          {
            id: 'p1',
            name: 'Arena',
            key: 'AR',
            cycle: 1,
            stage: 'BUILD',
            role: 'owner',
            member_count: 3,
          },
        ],
      }),
    );
    const arenas = await client.arenas();
    expect(arenas[0]).toMatchObject({ id: 'p1', stage: 'BUILD' });
    expect((fetch.mock.calls[0]![1].headers as Record<string, string>).Authorization).toBe(
      'Bearer tok',
    );
    const bad = api(() => json(200, { items: [{ name: 'no id' }] }));
    await expect(bad.client.arenas()).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('401 raises SarasAuthError and calls onUnauthorized; no token fails before fetching', async () => {
    const { client, onUnauthorized } = api(() =>
      json(401, { code: 'UNAUTHENTICATED', message: 'Sign in' }),
    );
    await expect(client.me()).rejects.toBeInstanceOf(SarasAuthError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    const none = api(() => json(200, {}), '');
    await expect(none.client.me()).rejects.toBeInstanceOf(SarasAuthError);
    expect(none.fetch).not.toHaveBeenCalled();
  });

  it('error bodies and network failures become readable errors', async () => {
    const { client } = api(() =>
      json(403, { error: { code: 'FORBIDDEN', message: 'Not a member' } }),
    );
    await expect(client.arenas()).rejects.toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Not a member',
    });
    const down = api(() => {
      throw new TypeError('fetch failed');
    });
    await expect(down.client.arenas()).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('llm models accept OpenAI-style lists and fill defaults', async () => {
    const { client } = api(() =>
      json(200, {
        data: [{ id: 'm1' }, { id: 'm2', name: 'Two', context_window: 1000, max_tokens: 100 }],
      }),
    );
    await expect(client.llmModels()).resolves.toEqual([
      { id: 'm1', name: 'm1', contextWindow: 128000, maxTokens: 16384, reasoning: false },
      { id: 'm2', name: 'Two', contextWindow: 1000, maxTokens: 100, reasoning: false },
    ]);
  });

  it('coding sessions, events, push and pulls use the contract paths and validate', async () => {
    const seen: string[] = [];
    const { client, fetch } = api((url, init) => {
      seen.push(`${init.method} ${url.replace('http://saras.test', '')}`);
      if (url.endsWith('/coding-sessions'))
        return json(201, { id: 's1', branch: 'saras/s1-fix', base_sha: 'abcdef1234' });
      if (url.endsWith('/pulls')) return json(201, { number: 7 });
      return new Response(null, { status: 204 });
    });
    await expect(
      client.startCodingSession('p 1', { title: 'Fix', description: 'd' }),
    ).resolves.toMatchObject({ branch: 'saras/s1-fix' });
    await client.postEvent('p 1', 's1', { kind: 'progress', summary: 'x'.repeat(600) });
    await client.push('p 1', 's1', new Uint8Array([1, 2, 3]));
    await expect(
      client.openPull('p 1', { coding_session_id: 's1', title: 'Fix' }),
    ).resolves.toEqual({ number: 7 });
    expect(seen).toEqual([
      'POST /v1/ext/projects/p%201/coding-sessions',
      'POST /v1/ext/projects/p%201/coding-sessions/s1/events',
      'POST /v1/ext/projects/p%201/coding-sessions/s1/push',
      'POST /v1/ext/projects/p%201/pulls',
    ]);
    const eventBody = JSON.parse(fetch.mock.calls[1]![1].body as string) as { summary: string };
    expect(eventBody.summary).toHaveLength(500);
    expect((fetch.mock.calls[2]![1].headers as Record<string, string>)['Content-Type']).toBe(
      'application/octet-stream',
    );
    expect(client.pullUrl('p1', 7)).toBe('http://saras.test/arena/p1?pr=7');
    await expect(client.push('p', 's', new Uint8Array(50 * 1024 * 1024 + 1))).rejects.toMatchObject(
      { status: 413 },
    );
  });

  it('rejects an unsafe base sha from the server', async () => {
    const { client } = api(() => json(201, { id: 's1', branch: 'b', base_sha: '; rm -rf' }));
    await expect(client.startCodingSession('p', { title: 'x' })).rejects.toMatchObject({
      code: 'BAD_RESPONSE',
    });
  });
});
