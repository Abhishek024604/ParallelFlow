import { describe, expect, it } from 'vitest';
import { safeDeepLink } from './notifications';

describe('inbox deep links', () => {
  it('follows app paths only', () => {
    expect(safeDeepLink('/arena/abc?artifact=def')).toBe('/arena/abc?artifact=def');
    expect(safeDeepLink('//evil.example')).toBe('/inbox');
    expect(safeDeepLink('https://evil.example')).toBe('/inbox');
    expect(safeDeepLink('/\\evil')).toBe('/inbox');
  });
});
