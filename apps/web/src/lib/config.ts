// Where the API lives (doc 11 §11.7).
// The browser only ever talks to the web origin: `next.config.ts` proxies `/v1/*` to the API, so
// sign-in links, mutations and the API's cookies are all same-origin. The Next server (middleware,
// server components) calls the API directly at API_URL (server-side only, default :4000).

const LOCAL_API = 'http://localhost:4000';

/** Server-side base URL of the API (also the proxy target in next.config.ts). */
export function serverApiUrl(): string {
  return (process.env.API_URL || LOCAL_API).replace(/\/+$/, '');
}

/** Where signed-in people land. */
export const HOME_PATH = '/arena';
