import { shortPreview, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';

// Unread arena messages, grouped: one Inbox row per member per arena (no read-marker table yet, no
// migration). The row is a normal notification with:
//   dedupe_key    'arena-unread:<project id>'  (UNIQUE (user_id, dedupe_key): the upsert target)
//   resource_type 'arena_unread'
//   resource_id   the FIRST unread message: kept while the row is unread, moved to the new message
//                 when a read row gets a new message. Unread count = top-level messages by others
//                 from that message on, counted when the Inbox is read (notifications.ts).
//   read_at       null while there is something new; set when you open the arena (markArenaRead)
//   created_at    the latest message, so the row moves to the top of the Inbox
//   preview       "<author>: <latest message>"
// Written in the same transaction as the message. Thread replies do not count (they notify the
// thread's author instead). The author is never notified of their own message.

export const ARENA_UNREAD = 'arena_unread';
export const arenaUnreadKey = (projectId: string): string => `arena-unread:${projectId}`;

export async function bumpArenaUnread(
  tx: Tx,
  input: {
    arenaId: string;
    messageId: string;
    author: { type: 'user' | 'agent' | 'system'; id: string; name: string };
    body: string;
  },
): Promise<void> {
  const preview = shortPreview(`${input.author.name}: ${input.body}`);
  const authorUser = input.author.type === 'user' ? input.author.id : null;
  await sql`
    INSERT INTO notifications (org_id, user_id, type, project_id, title, preview, resource_type,
                               resource_id, deep_link, actor_type, actor_id, requires_action,
                               dedupe_key, created_at)
    SELECT a.org_id, pm.user_id, 'system'::notification_type, a.project_id,
           'New messages in ' || p.name, ${preview}, ${ARENA_UNREAD}, ${input.messageId}::uuid,
           '/arena/' || a.project_id || '?message=' || ${input.messageId},
           ${input.author.type}::principal_type, ${input.author.id}::uuid, false,
           'arena-unread:' || a.project_id, clock_timestamp()
      FROM arenas a
      JOIN projects p ON p.id = a.project_id
      JOIN project_members pm ON pm.project_id = a.project_id
      JOIN org_memberships om ON om.org_id = pm.org_id AND om.user_id = pm.user_id
                             AND om.status = 'active'
     WHERE a.id = ${input.arenaId}
       AND pm.user_id IS DISTINCT FROM ${authorUser}::uuid
    ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
      resource_id = CASE WHEN notifications.read_at IS NULL THEN notifications.resource_id
                         ELSE EXCLUDED.resource_id END,
      deep_link   = CASE WHEN notifications.read_at IS NULL THEN notifications.deep_link
                         ELSE EXCLUDED.deep_link END,
      read_at = NULL,
      resolved_at = NULL,
      title = EXCLUDED.title,
      preview = EXCLUDED.preview,
      actor_type = EXCLUDED.actor_type,
      actor_id = EXCLUDED.actor_id,
      created_at = EXCLUDED.created_at`.execute(tx);
}

/**
 * The unread count of a grouped row, as an SQL expression over `n` (a notifications row) for the
 * reader `me` (an SQL literal). Used inside the Inbox read (raw SQL, literal values only).
 */
export function unreadCountSql(me: string): string {
  return `CASE WHEN n.resource_type = '${ARENA_UNREAD}' AND n.read_at IS NULL THEN (
            SELECT count(*) FROM messages m
              JOIN arenas a ON a.id = m.arena_id
             WHERE a.project_id = n.project_id AND m.parent_id IS NULL AND m.deleted_at IS NULL
               AND m.author_id <> ${me}
               AND m.created_at >= (SELECT f.created_at FROM messages f
                                     WHERE f.id = n.resource_id AND f.arena_id = a.id LIMIT 1))
          END`;
}

/** "3 new messages in Checkout". */
export function unreadTitle(count: number, arenaName: string): string {
  return `${count} new ${count === 1 ? 'message' : 'messages'} in ${arenaName}`;
}
