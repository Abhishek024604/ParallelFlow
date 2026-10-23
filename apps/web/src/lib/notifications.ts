import type {
  InboxNotification,
  InboxNotificationType,
  NotificationFilter,
  NotificationPage,
} from '@parallelflow/contracts';
import { apiGet, apiPost } from './api-browser';

// Inbox helpers shared by the top-bar bell and the Inbox page.

export const NOTIFICATIONS_CHANGED_EVENT = 'parallelflow:notifications-changed';
/** The bell's latest page (detail: NotificationPage), e.g. for the arena sidebar's unread badges. */
export const NOTIFICATIONS_PAGE_EVENT = 'parallelflow:notifications-page';

export const TYPE_LABELS: Record<InboxNotificationType, string> = {
  artifact_push: 'Artifact push',
  stage_update: 'Stage update',
  delegation: 'Delegation',
  tag: 'Tag',
  dm: 'DM',
  approval_request: 'Approval',
  access_request: 'Access',
  assignment: 'Assignment',
  routine: 'Routine',
  system: 'Update',
};

export function fetchNotifications(
  filter: NotificationFilter = 'all',
  options: { limit?: number; cursor?: string | null; signal?: AbortSignal } = {},
): Promise<NotificationPage> {
  const params = new URLSearchParams({ filter, limit: String(options.limit ?? 20) });
  if (options.cursor) params.set('cursor', options.cursor);
  return apiGet<NotificationPage>(`/me/notifications?${params.toString()}`, options.signal);
}

function announce(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED_EVENT));
}

export async function markRead(id: string): Promise<void> {
  await apiPost<undefined>(`/me/notifications/${encodeURIComponent(id)}/read`);
  announce();
}

/** You are looking at this arena: its "new messages" item is read. */
export async function markArenaRead(projectId: string): Promise<void> {
  await apiPost<undefined>(`/me/notifications/arenas/${encodeURIComponent(projectId)}/read`);
  announce();
}

/** Inbox label of an item; an arena's grouped "new messages" item reads "Messages". */
export function typeLabel(n: InboxNotification): string {
  return n.unread_messages !== undefined ? 'Messages' : TYPE_LABELS[n.type];
}

export async function markAllRead(): Promise<void> {
  await apiPost<{ updated: number }>('/me/notifications/read-all');
  announce();
}

/** Only an app path is followed ("/arena/…"); anything else goes to the Inbox. */
export function safeDeepLink(link: string): string {
  return /^\/(?!\/|\\)[\w\-./?=&%]*$/.test(link) ? link : '/inbox';
}

export function isUnread(n: InboxNotification): boolean {
  return n.read_at === null;
}

/** "10:21" today, "Mon" this week, else "12 Oct". */
export function notificationTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = (now.getTime() - date.getTime()) / 86_400_000;
  if (days < 6) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
