import { z } from 'zod';

// Inbox (C9): GET /me/notifications, POST /me/notifications/{id}:read, POST /me/notifications:read-all.
// Notifications are written by the events themselves (gate requests and decisions, mentions, pushes,
// joins, AI drafts); these routes only read them and mark them read.

export const NOTIFICATION_PAGE_MAX = 50;
export const NOTIFICATION_PAGE_DEFAULT = 20;

export const NOTIFICATION_FILTERS = ['all', 'action', 'unread'] as const;
export type NotificationFilter = (typeof NOTIFICATION_FILTERS)[number];

export const ListNotificationsQuerySchema = z
  .object({
    filter: z.enum(NOTIFICATION_FILTERS).default('all'),
    limit: z.coerce
      .number()
      .int('Must be a whole number')
      .min(1, 'At least 1')
      .max(NOTIFICATION_PAGE_MAX, `At most ${NOTIFICATION_PAGE_MAX}`)
      .default(NOTIFICATION_PAGE_DEFAULT),
    cursor: z.string().max(200).optional(),
  })
  .strict();
export type ListNotificationsQuery = z.output<typeof ListNotificationsQuerySchema>;

export type InboxNotificationType =
  | 'artifact_push'
  | 'stage_update'
  | 'delegation'
  | 'tag'
  | 'dm'
  | 'approval_request'
  | 'access_request'
  | 'assignment'
  | 'routine'
  | 'system';

export interface InboxNotification {
  id: string;
  type: InboxNotificationType;
  /** The arena it is about. */
  project_id: string;
  arena_name: string;
  title: string;
  /** A short excerpt (≤ 140 characters), or null. */
  preview: string | null;
  /** An app path, e.g. /arena/<id>. */
  deep_link: string;
  requires_action: boolean;
  read_at: string | null;
  resolved_at: string | null;
  /** RFC 3339, UTC, microseconds. */
  created_at: string;
}

export interface NotificationPage {
  /** Newest first. */
  items: InboxNotification[];
  /** Pass as `cursor` for the next (older) page; null at the end. */
  next_cursor: string | null;
  /** Unread notifications across all your arenas. */
  unread_count: number;
  /** Notifications that still need your action (e.g. a gate to approve). */
  action_count: number;
}
