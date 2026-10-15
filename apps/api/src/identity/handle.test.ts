import { describe, expect, it } from 'vitest';
import { displayNameFor, handleBase, handleCandidate, isValidHandle } from './handle.js';

describe('handleBase', () => {
  it.each([
    ['priya@acme.io', 'priya'],
    ['Priya.K+test@acme.io', 'priya-k-test'],
    ['renée.dupont@x.fr', 'renee-dupont'],
    ['a@x.io', 'user-a'],
    ['__@x.io', 'user'],
    ['日本@x.jp', 'user'],
    ['very.long.local.part.that.goes.on.and.on@x.io', 'very-long-local-part-tha'],
    ['o_k-ay@x.io', 'o_k-ay'],
  ])('%s → %s', (email, expected) => {
    expect(handleBase(email)).toBe(expected);
    expect(isValidHandle(handleBase(email))).toBe(true);
  });
});

describe('handleCandidate', () => {
  it('uses the base first, then adds a random 4-character suffix within the pattern', () => {
    expect(handleCandidate('priya', 0)).toBe('priya');
    const next = handleCandidate('very-long-local-part-tha', 1);
    expect(next).toMatch(/^very-long-local-part-tha-[a-z0-9]{4}$/);
    expect(isValidHandle(next)).toBe(true);
  });
});

describe('displayNameFor', () => {
  it('uses first and last name, else the email local part', () => {
    expect(displayNameFor({ email: 'p@x.io', firstName: ' Priya ', lastName: 'K' })).toBe(
      'Priya K',
    );
    expect(displayNameFor({ email: 'p@x.io', firstName: 'Priya', lastName: null })).toBe('Priya');
    expect(displayNameFor({ email: 'dev.ops@x.io', firstName: '', lastName: null })).toBe(
      'dev.ops',
    );
  });

  it('caps at 80 characters', () => {
    expect(
      displayNameFor({ email: 'p@x.io', firstName: 'A'.repeat(200), lastName: null }),
    ).toHaveLength(80);
  });
});
