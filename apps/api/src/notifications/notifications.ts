import type {
  InboxNotification,
  ListNotificationsQuery,
  NotificationFilter,
  NotificationPage,
} from '@saras/contracts';
import { readInEachMemberProject, sqlLiteral, type Tx } from '@saras/db';
import { decodeCursor, encodeCursor, type MessageCursor } from '../arenas/cursor.js';
import { notFound, validationFailed } from '../pipeline/errors.js';
import { ARENA_UNREAD, arenaUnreadKey, unreadCountSql, unreadTitle } from './arena-unread.js';

// The Inbox, read from user scope. Notifications are tenant rows (RLS: the org's context), so each
// org's rows are read in its own verified tenant context, in one transaction
// (readInEachMemberProject), and always filtered to the caller's own rows and current arenas.
// Nothing here logs titles or previews.

const TS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

interface OrgPage {
  unread: number;
  action: number;
  items: (InboxNotification & { group: string | null })[];
  arenas: { project_id: string; count: number }[];
}

function filterSql(filter: NotificationFilter): string {
  if (filter === 'unread') return 'AND read_at IS NULL';
  if (filter === 'action') return 'AND requires_action AND resolved_at IS NULL';
  return '';
}

/** Newest first across every arena; `cursor` continues after the last item of a page. */
export async function listNotifications(
  userTx: Tx,
  userId: string,
  query: ListNotificationsQuery,
): Promise<NotificationPage> {
  let cursor: MessageCursor | null = null;
  if (query.cursor) {
    cursor = decodeCursor(query.cursor);
    if (!cursor) throw validationFailed([{ field: 'cursor', message: 'Invalid cursor' }]);
  }
  const me = sqlLiteral(userId);
  const after = cursor
    ? `AND (n.created_at, n.id) < (${sqlLiteral(cursor.createdAt)}::timestamptz, ${sqlLiteral(cursor.id)}::uuid)`
    : '';
  const limit = query.limit;
  const pages = await readInEachMemberProject<{ page: OrgPage }>(
    userTx,
    userId,
    (ids) => `
      WITH mine AS (
        SELECT n.id, n.type::text AS type, n.project_id, p.name AS arena_name, n.title, n.preview,
               n.deep_link, n.requires_action, n.created_at AS created_ts,
               CASE WHEN n.resource_type = '${ARENA_UNREAD}' THEN n.resource_type END AS grp,
               ${unreadCountSql(me)} AS unread_messages,
               to_char(n.read_at AT TIME ZONE 'UTC', ${TS}) AS read_at,
               to_char(n.resolved_at AT TIME ZONE 'UTC', ${TS}) AS resolved_at,
               to_char(n.created_at AT TIME ZONE 'UTC', ${TS}) AS created_at
          FROM notifications n
          JOIN projects p ON p.id = n.project_id
         WHERE n.user_id = ${me} AND n.project_id IN ${ids}
      ), page AS (
        SELECT * FROM mine n WHERE true ${filterSql(query.filter)} ${after}
         ORDER BY created_ts DESC, id DESC LIMIT ${limit + 1}
      )
      SELECT json_build_object(
        'unread', (SELECT count(*) FROM mine WHERE read_at IS NULL),
        'action', (SELECT count(*) FROM mine WHERE requires_action AND resolved_at IS NULL),
        'items', COALESCE((SELECT json_agg(json_build_object(
                   'id', id, 'type', type, 'project_id', project_id, 'arena_name', arena_name,
                   'title', title, 'preview', preview, 'deep_link', deep_link,
                   'requires_action', requires_action, 'read_at', read_at,
                   'resolved_at', resolved_at, 'created_at', created_at, 'group', grp,
                   'unread_messages', unread_messages)) FROM page), '[]'::json),
        'arenas', COALESCE((SELECT json_agg(json_build_object(
                   'project_id', project_id, 'count', unread_messages))
                   FROM mine WHERE unread_messages > 0), '[]'::json)
      ) AS page`,
  );
  const all = pages.flatMap((p) => p.page.items).map(toItem);
  // created_at strings are fixed-width UTC with microseconds: they sort as text.
  all.sort((a, b) =>
    a.created_at === b.created_at
      ? b.id.localeCompare(a.id)
      : b.created_at.localeCompare(a.created_at),
  );
  const items = all.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    next_cursor:
      all.length > limit && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null,
    unread_count: pages.reduce((n, p) => n + Number(p.page.unread), 0),
    action_count: pages.reduce((n, p) => n + Number(p.page.action), 0),
    arena_unread: pages.flatMap((p) =>
      p.page.arenas.map((a) => ({ project_id: a.project_id, count: Number(a.count) })),
    ),
  };
}

/** A grouped "new messages" row gets its live count and title; other rows pass through. */
function toItem(row: OrgPage['items'][number]): InboxNotification {
  const { group, unread_messages: count, ...item } = row;
  if (group !== ARENA_UNREAD) return item;
  const n = Number(count ?? 0);
  return {
    ...item,
    unread_messages: n,
    ...(n > 0 && { title: unreadTitle(n, item.arena_name) }),
  };
}

/** Marks one of your notifications read (idempotent). 404 if it is not yours. */
export async function markNotificationRead(
  userTx: Tx,
  userId: string,
  notificationId: string,
): Promise<void> {
  const me = sqlLiteral(userId);
  const id = sqlLiteral(notificationId);
  const rows = await readInEachMemberProject<{ id: string }>(
    userTx,
    userId,
    (ids) => `
      UPDATE notifications SET read_at = COALESCE(read_at, now()),
             resolved_at = CASE WHEN type = 'tag' AND requires_action
                                THEN COALESCE(resolved_at, now()) ELSE resolved_at END
       WHERE id = ${id} AND user_id = ${me} AND project_id IN ${ids}
      RETURNING id`,
  );
  if (rows.length === 0) throw notFound();
}

/** Marks all your notifications read; returns how many changed. */
export async function markAllNotificationsRead(userTx: Tx, userId: string): Promise<number> {
  const me = sqlLiteral(userId);
  const rows = await readInEachMemberProject<{ id: string }>(
    userTx,
    userId,
    (ids) => `
      UPDATE notifications SET read_at = now()
       WHERE user_id = ${me} AND project_id IN ${ids} AND read_at IS NULL
      RETURNING id`,
  );
  return rows.length;
}

/**
 * You opened an arena: its grouped "new messages" item is read (idempotent). Not a 404 for an arena
 * you are not in: nothing matches, nothing changes.
 */
export async function markArenaRead(userTx: Tx, userId: string, projectId: string): Promise<void> {
  const me = sqlLiteral(userId);
  const project = sqlLiteral(projectId);
  const key = sqlLiteral(arenaUnreadKey(projectId));
  await readInEachMemberProject<{ id: string }>(
    userTx,
    userId,
    (ids) => `
      UPDATE notifications SET read_at = now()
       WHERE user_id = ${me} AND project_id = ${project} AND project_id IN ${ids}
         AND dedupe_key = ${key} AND read_at IS NULL
      RETURNING id`,
  );
}
