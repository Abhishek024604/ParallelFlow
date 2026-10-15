import { describe, expect, it } from 'vitest';
import { csrfRequired, csrfValid } from './csrf.js';

describe('csrfRequired', () => {
  it('exempts safe methods only', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(csrfRequired(m), m).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE', 'patch'])
      expect(csrfRequired(m), m).toBe(true);
  });
});

describe('csrfValid', () => {
  const token = 't'.repeat(43);

  it('accepts exactly the session token', () => {
    expect(csrfValid(token, token)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['different', 'u'.repeat(43)],
    ['prefix', token.slice(0, 20)],
    ['longer', `${token}x`],
    ['repeated header', [token, token]],
    ['huge', 'x'.repeat(10_000)],
  ])('rejects a %s header', (_label, header) => {
    expect(csrfValid(header, token)).toBe(false);
  });
});
