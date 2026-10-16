import type { ArenaDetail, ArenaList, InvitePreview, Me } from '@saras/contracts';
import { cookies } from 'next/headers';
import { serverApiUrl } from './config';

// API calls from server components. They forward the browser's cookies (already refreshed by the
// middleware) and never cache: every response is per user. Cookie values are never logged.

export class ApiUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`API request failed (${status})`);
    this.name = 'ApiUnavailableError';
  }
}

async function call(path: string): Promise<Response> {
  const jar = await cookies();
  return fetch(`${serverApiUrl()}/v1${path}`, {
    headers: { cookie: jar.toString(), accept: 'application/json' },
    cache: 'no-store',
  });
}

/** JSON body for 2xx; null for the listed "expected" statuses; throws otherwise. */
async function json<T>(path: string, nullOn: readonly number[]): Promise<T | null> {
  const res = await call(path);
  if (res.ok) return (await res.json()) as T;
  if (nullOn.includes(res.status)) return null;
  throw new ApiUnavailableError(res.status);
}

/** Your profile, or null when signed out. */
export function getMe(): Promise<Me | null> {
  return json<Me>('/me', [401]);
}

export async function getArenas(): Promise<ArenaList> {
  return (await json<ArenaList>('/arenas', [])) ?? { items: [] };
}

/** One arena, or null when it does not exist or you are not a member. */
export function getArena(arenaId: string): Promise<ArenaDetail | null> {
  return json<ArenaDetail>(`/arenas/${encodeURIComponent(arenaId)}`, [403, 404]);
}

/** What an invite link is for, or null when it is invalid, expired or used. */
export function getInvite(token: string): Promise<InvitePreview | null> {
  return json<InvitePreview>(`/invites/${encodeURIComponent(token)}`, [404, 410]);
}
