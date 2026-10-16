// Where the API lives (doc 11 §11.7).
//   API_URL              used by the Next server (middleware, server components). Default :4000.
//   NEXT_PUBLIC_API_URL  used by the browser (sign-in links, create arena, join, sign out).
// Both default to the local API, so `pnpm dev` needs neither.

const LOCAL_API = 'http://localhost:4000';

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Server-side base URL of the API. */
export function serverApiUrl(): string {
  return trimSlash(process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || LOCAL_API);
}

/** Browser-side base URL of the API (inlined at build time). */
export const PUBLIC_API_URL = trimSlash(process.env.NEXT_PUBLIC_API_URL || LOCAL_API);

/** Where signed-in people land. */
export const HOME_PATH = '/arena';
