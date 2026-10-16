import type {
  ArtifactList,
  ArenaDetail,
  ArenaList,
  ArenaMessagePage,
  ChatMessagePage,
  InvitePreview,
  Me,
  PrivateChat,
  PrivateChatList,
  PrivateMessage,
  PrivateProjectList,
  ProjectMemberList,
} from '@saras/contracts';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { serverApiUrl } from './config';

// API calls from server components. They go straight to the API at API_URL (not back through the
// web origin's /v1 proxy: one hop fewer, and no need to know the web's own public URL), forwarding
// the browser's cookies as the middleware left them, i.e. already refreshed. Server components
// cannot set cookies, so the middleware is what passes a refreshed `saras_session` to the browser.
// Never cached across requests: every response is per user. Cookie values are never logged.

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

/** Your profile, or null when signed out. One call per render, however many layouts ask. */
export const getMe = cache((): Promise<Me | null> => json<Me>('/me', [401]));

export const getArenas = cache(
  async (): Promise<ArenaList> => (await json<ArenaList>('/arenas', [])) ?? { items: [] },
);

/** One arena, or null when it does not exist or you are not a member. */
export function getArena(arenaId: string): Promise<ArenaDetail | null> {
  return json<ArenaDetail>(`/arenas/${encodeURIComponent(arenaId)}`, [403, 404]);
}

/** The latest page of an arena's messages, or null when you are not a member. */
export function getArenaMessages(arenaId: string): Promise<ArenaMessagePage | null> {
  return json<ArenaMessagePage>(
    `/projects/${encodeURIComponent(arenaId)}/arena/messages`,
    [403, 404],
  );
}

/** An arena's members and whether you can post, or null when you are not a member. */
export function getMembers(arenaId: string): Promise<ProjectMemberList | null> {
  return json<ProjectMemberList>(`/projects/${encodeURIComponent(arenaId)}/members`, [403, 404]);
}

/** What an invite link is for, or null when it is invalid, expired or used. */
export function getInvite(token: string): Promise<InvitePreview | null> {
  return json<InvitePreview>(`/invites/${encodeURIComponent(token)}`, [404, 410]);
}

/** Your private chats (newest activity first). Deduped across the layout and the page. */
export const getPrivateChats = cache(
  async (): Promise<PrivateChatList> =>
    (await json<PrivateChatList>('/private/sessions', [])) ?? { items: [], next_cursor: null },
);

/** Your private projects, oldest first, with chat counts. */
export const getPrivateProjects = cache(
  async (): Promise<PrivateProjectList> =>
    (await json<PrivateProjectList>('/private/projects', [])) ?? { items: [] },
);

/** One of your private chats, or null (not yours, or gone). */
export function getPrivateChat(id: string): Promise<PrivateChat | null> {
  return json<PrivateChat>(`/private/sessions/${encodeURIComponent(id)}`, [404]);
}

/** The latest page of a private chat, or null. */
export function getPrivateMessages(id: string): Promise<ChatMessagePage<PrivateMessage> | null> {
  return json<ChatMessagePage<PrivateMessage>>(
    `/private/sessions/${encodeURIComponent(id)}/messages`,
    [404],
  );
}

/** Your private files (My files), most recently updated first. */
export const getPrivateFiles = cache(
  async (): Promise<ArtifactList> =>
    (await json<ArtifactList>('/artifacts?scope=private', [])) ?? { items: [], next_cursor: null },
);
