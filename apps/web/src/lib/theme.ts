// Theme (light mode, avatar menu): System follows prefers-color-scheme live through the CSS media
// query; Light / Dark put `.light` / `.dark` on <html>. The choice is kept in a cookie, so the root
// layout renders the right class with no flash, and in localStorage as a fallback.

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = 'saras-theme';
const STORAGE_KEY = 'saras-theme';
const YEAR_S = 365 * 24 * 60 * 60;

export const isTheme = (value: unknown): value is Theme =>
  typeof value === 'string' && (THEMES as readonly string[]).includes(value);

/** The <html> class for a theme: none for System (the media query decides). */
export const themeClass = (theme: Theme): string => (theme === 'system' ? '' : theme);

/** The saved theme: the cookie first, then localStorage, else System. Browser only. */
export function readTheme(): Theme {
  const match = /(?:^|;\s*)saras-theme=([a-z]+)/.exec(document.cookie);
  if (isTheme(match?.[1])) return match[1];
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {
    // Storage blocked: System.
  }
  return 'system';
}

/** Applies a theme to <html> and saves it (cookie + localStorage). Browser only. */
export function applyTheme(theme: Theme): void {
  const html = document.documentElement;
  html.classList.remove('light', 'dark');
  const cls = themeClass(theme);
  if (cls) html.classList.add(cls);
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=${YEAR_S}; samesite=lax`;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The cookie is enough.
  }
}

/**
 * Inline script for <head>: when there is no cookie (cleared, or set in another browser profile),
 * applies the localStorage choice before the first paint and restores the cookie.
 */
export const THEME_FALLBACK_SCRIPT = `(function(){try{if(/(?:^|;\\s*)${THEME_COOKIE}=/.test(document.cookie))return;var t=localStorage.getItem('${STORAGE_KEY}');if(t!=='light'&&t!=='dark'&&t!=='system')return;var h=document.documentElement;h.classList.remove('light','dark');if(t!=='system')h.classList.add(t);document.cookie='${THEME_COOKIE}='+t+'; path=/; max-age=${YEAR_S}; samesite=lax';}catch(e){}})();`;
