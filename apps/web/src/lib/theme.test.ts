import { describe, expect, it } from 'vitest';
import { isTheme, THEME_FALLBACK_SCRIPT, themeClass } from './theme';

describe('theme', () => {
  it('maps a saved choice to the <html> class (none for System)', () => {
    expect(themeClass('system')).toBe('');
    expect(themeClass('light')).toBe('light');
    expect(themeClass('dark')).toBe('dark');
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('blue')).toBe(false);
    expect(isTheme(undefined)).toBe(false);
  });

  it('ships a fallback script that parses', () => {
    expect(() => new Function(THEME_FALLBACK_SCRIPT)).not.toThrow();
  });
});
