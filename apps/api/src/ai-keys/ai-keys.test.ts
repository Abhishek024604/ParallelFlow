import { describe, expect, it } from 'vitest';
import { checkKey, knowsModel, listProviders } from './ai-keys.js';

describe('AI provider keys (ADR-043)', () => {
  const reply = (status: number, seen?: { url: string; headers: Headers }[]) =>
    (async (url: string, init?: RequestInit) => {
      seen?.push({ url, headers: new Headers(init?.headers) });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;

  it('checks a key with the provider: accepted, refused or unreachable', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    expect(await checkKey('openai', 'sk-test', reply(200, seen))).toBe('ok');
    expect(seen[0]?.url).toBe('https://api.openai.com/v1/models');
    expect(seen[0]?.headers.get('authorization')).toBe('Bearer sk-test');
    await checkKey('anthropic', 'sk-ant', reply(200, seen));
    expect(seen[1]?.headers.get('x-api-key')).toBe('sk-ant');
    expect(await checkKey('openai', 'sk', reply(401))).toBe('refused');
    expect(await checkKey('openai', 'sk', reply(429))).toBe('ok');
    expect(await checkKey('openai', 'sk', reply(503))).toBe('unreachable');
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await checkKey('openai', 'sk', down)).toBe('unreachable');
  });

  it("lists each provider's models from Pi's catalogue", async () => {
    const list = await listProviders();
    expect(list.items.map((p) => p.id)).toContain('deepseek');
    expect(list.items.find((p) => p.id === 'openai')?.models.length).toBeGreaterThan(0);
    expect(await knowsModel('openai', 'gpt-4.1')).toBe(true);
    expect(await knowsModel('openai', 'no-such-model')).toBe(false);
  });
});
