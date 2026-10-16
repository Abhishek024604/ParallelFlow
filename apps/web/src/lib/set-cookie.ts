// The API refreshes the session cookie on some requests (ADR-032: WorkOS refresh, last-seen touch).
// When the Next server calls the API for the browser, it must pass those Set-Cookie headers on, or
// the rotated refresh token is lost. Values are only passed through, never logged.

export interface CookieUpdate {
  name: string;
  /** null = the API cleared the cookie. */
  value: string | null;
}

/** Name and value of one Set-Cookie line; cleared when empty, Max-Age=0 or expired. */
export function parseSetCookie(line: string, now = Date.now()): CookieUpdate | null {
  const [pair, ...attrs] = line.split(';').map((part) => part.trim());
  if (!pair) return null;
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  let cleared = value === '';
  for (const attr of attrs) {
    const [key = '', raw = ''] = attr.split('=');
    const k = key.trim().toLowerCase();
    if (k === 'max-age' && Number(raw) <= 0) cleared = true;
    if (k === 'expires') {
      const at = Date.parse(raw);
      if (!Number.isNaN(at) && at <= now) cleared = true;
    }
  }
  return { name, value: cleared ? null : value };
}

/** Applies updates to a Cookie request header and returns the new header. */
export function applyToCookieHeader(header: string, updates: readonly CookieUpdate[]): string {
  const jar = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const update of updates) {
    if (update.value === null) jar.delete(update.name);
    else jar.set(update.name, update.value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}
