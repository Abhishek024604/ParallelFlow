// Where to send the browser after login (`GET /auth/login?return_to=`). Only the web app: a relative
// path, or an absolute URL on WEB_ORIGIN. Anything else falls back to the web app's root, so the API
// is never an open redirect (doc 10 §10.5).

const MAX_LENGTH = 2048;
// Control characters, backslashes (browsers read `/\evil.example` as `//evil.example`) and spaces.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000- \u007f\\]/;

export function webRoot(webOrigin: string): string {
  return new URL('/', webOrigin).toString();
}

export function safeReturnTo(raw: unknown, webOrigin: string): string {
  const fallback = webRoot(webOrigin);
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return fallback;
  if (UNSAFE.test(raw)) return fallback;
  const origin = new URL(webOrigin).origin;

  let url: URL;
  try {
    if (raw.startsWith('/')) {
      // `//host` and `/\host` are protocol-relative: another site.
      if (raw.startsWith('//')) return fallback;
      url = new URL(raw, origin);
    } else {
      url = new URL(raw);
    }
  } catch {
    return fallback;
  }
  if (url.origin !== origin || url.username || url.password) return fallback;
  return url.toString();
}
