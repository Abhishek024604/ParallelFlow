import { describe, expect, it } from 'vitest';
import { linearLabel } from './extensions.js';

describe('linearLabel', () => {
  const reply = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('names the workspace and person a key belongs to', async () => {
    const ok = reply(200, { data: { viewer: { name: 'Dana' }, organization: { name: 'Acme' } } });
    expect(await linearLabel('lin_api_x', ok)).toBe('Acme · Dana');
  });

  it('is null when Linear refuses the key or cannot be reached', async () => {
    expect(await linearLabel('bad', reply(401, { errors: [] }))).toBeNull();
    expect(await linearLabel('bad', reply(200, { errors: [{ message: 'x' }] }))).toBeNull();
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await linearLabel('x', down)).toBeNull();
  });
});
