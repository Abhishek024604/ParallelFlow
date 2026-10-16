import { describe, expect, it } from 'vitest';
import { arenaKey, initials, inviteSecretHash, maskEmail, randomSlug } from './naming.js';

describe('arenaKey', () => {
  it.each([
    ['Interview Prep Platform', 'IPP'],
    ['Interview Prep', 'IP'],
    ['Checkout', 'CHE'],
    ['a b c d e', 'ABCD'],
    ['Café crème', 'CC'],
    ['Q', 'AR'],
    ['数据平台', 'AR'],
    ['  2026 roadmap  ', 'ROA'],
  ])('%s → %s', (name, key) => {
    expect(arenaKey(name)).toBe(key);
    expect(key).toMatch(/^[A-Z]{2,4}$/);
  });
});

describe('helpers', () => {
  it('initials', () => {
    expect(initials('Riya Sharma')).toBe('RS');
    expect(initials('Neha K Verma')).toBe('NV');
    expect(initials('abhishek')).toBe('A');
    expect(initials('  ')).toBe('?');
  });

  it('masks emails but keeps the domain', () => {
    expect(maskEmail('riya@adva.ai')).toBe('r***@adva.ai');
    expect(maskEmail('nope')).toBe('***');
  });

  it('hashes secrets with SHA-256 hex and makes random slugs', () => {
    expect(inviteSecretHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(randomSlug()).toMatch(/^a-[0-9a-f]{18}$/);
    expect(randomSlug()).not.toBe(randomSlug());
  });
});
