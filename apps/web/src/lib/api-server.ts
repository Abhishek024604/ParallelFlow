import type {
  ArenaDetail,
  ArenaList,
  ArenaMessagePage,
  ArtifactList,
  ChatMessagePage,
  ExtensionList,
  InvitePreview,
  LoopState,
  Me,
  PrivateChat,
  PrivateChatList,
  PrivateMessage,
  PrivateProjectList,
  ProjectMemberList,
  RoleList,
  RoleTemplateList,
} from '@parallelflow/contracts';
import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { serverApiUrl } from './config';

// API calls from server components. They go straight to the API at API_URL (not back through the
// web origin's /v1 proxy: one hop fewer, and no need to know the web's own public URL), forwarding
// the browser's cookies as the middleware left them, i.e. already refreshed. Server components
// cannot set cookies, so the middleware is what passes a refreshed `parallelflow_session` to the browser.
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
export const getMe = cache(async (): Promise<Me | null> => {
  // The middleware already asked /v1/me for this navigation and passes the answer along.
  const forwarded = (await headers()).get('x-parallelflow-me');
  if (forwarded) {
    try {
      return JSON.parse(decodeURIComponent(forwarded)) as Me;
    } catch {
      // Fall back to asking the API.
    }
  }
  return json<Me>('/me', [401]);
});

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

/** The arena's cycle, stage, gate and gate requests, or null when you are not a member. */
export function getLoopState(arenaId: string): Promise<LoopState | null> {
  return json<LoopState>(`/projects/${encodeURIComponent(arenaId)}/cycles/current`, [403, 404]);
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

/** The extensions marketplace: the catalog, what you installed and your connected services. */
export const getExtensions = cache(
  async (): Promise<ExtensionList> =>
    (await json<ExtensionList>('/private/extensions', [])) ?? { extensions: [], connections: [] },
);

/** The keys of the extensions you installed ("pm", "swa"). */
export const installedExtensions = cache(async (): Promise<string[]> =>
  (await getExtensions()).extensions.filter((e) => e.installed).map((e) => e.key),
);

/** An arena's roles and whether you can change them, or null when you are not a member. */
export function getRoles(arenaId: string): Promise<RoleList | null> {
  return json<RoleList>(`/projects/${encodeURIComponent(arenaId)}/roles`, [403, 404]);
}

/** The role templates (fixed, from the contract). */
export const getRoleTemplates = cache(
  async (): Promise<RoleTemplateList> =>
    (await json<RoleTemplateList>('/role-templates', [])) ?? { items: [] },
);
