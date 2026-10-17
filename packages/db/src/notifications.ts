import { sql } from 'kysely';
import type { Tx } from './database.js';

// Inbox notifications (C9). Written in the same tenant transaction as the event that causes them
// (a gate request, a vote, a mention, a push, a join), so they exist exactly when the event does.
// One row per recipient; UNIQUE (user_id, dedupe_key) makes a retried event a no-op. The preview is
// a short excerpt of tenant data under the notifications RLS policy; nothing here logs it.

export type NotificationType =
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

export type NotifyRecipients =
  /** These people (still filtered to the project's active members). */
  | { userIds: readonly string[] }
  /** Every active member of the project. */
  | { members: true }
  /** Active members holding one of these project roles (gate approvers). */
  | { roleIds: readonly string[] };

export interface NotifyInput {
  orgId: string;
  projectId: string;
  type: NotificationType;
  title: string;
  preview?: string | null;
  resourceType: string;
  resourceId: string;
  deepLink: string;
  /** Who caused it; a person is never notified of their own action. */
  actor?: { type: 'user' | 'agent' | 'system'; id: string } | null;
  requiresAction?: boolean;
  /** Same key for the same event: one notification per person, however often it is written. */
  dedupeKey: string;
  recipients: NotifyRecipients;
}

export const NOTIFICATION_PREVIEW_MAX_CHARS = 140;
const TITLE_MAX_CHARS = 200;

/** One line, at most `max` characters, with an ellipsis when cut. */
export function shortPreview(
  text: string | null | undefined,
  max = NOTIFICATION_PREVIEW_MAX_CHARS,
): string | null {
  const line = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return null;
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** The values one notify() writes (pure: unit tested). */
export function notificationValues(input: NotifyInput) {
  const actorUser = input.actor?.type === 'user' ? input.actor.id : null;
  const userIds =
    'userIds' in input.recipients
      ? [...new Set(input.recipients.userIds)].filter((id) => id !== actorUser)
      : null;
  return {
    title: shortPreview(input.title, TITLE_MAX_CHARS) ?? 'Update',
    preview: shortPreview(input.preview),
    actorUser,
    userIds,
    requiresAction: input.requiresAction ?? false,
    dedupeKey: input.dedupeKey.slice(0, 200),
  };
}

/**
 * Writes the notification for each recipient (one statement). Recipients are always limited to the
 * project's active members, so nothing reaches someone outside the arena.
 */
export async function notify(tx: Tx, input: NotifyInput): Promise<void> {
  const v = notificationValues(input);
  if (v.userIds && v.userIds.length === 0) return;
  if ('roleIds' in input.recipients && input.recipients.roleIds.length === 0) return;
  const filter = v.userIds
    ? sql`AND pm.user_id = ANY(${v.userIds}::uuid[])`
    : 'roleIds' in input.recipients
      ? sql`AND EXISTS (SELECT 1 FROM project_member_roles pmr
                         WHERE pmr.project_id = pm.project_id AND pmr.user_id = pm.user_id
                           AND pmr.role_id = ANY(${[...input.recipients.roleIds]}::uuid[]))`
      : sql``;
  await sql`
    INSERT INTO notifications (org_id, user_id, type, project_id, title, preview, resource_type,
                               resource_id, deep_link, actor_type, actor_id, requires_action,
                               dedupe_key)
    SELECT ${input.orgId}, pm.user_id, ${input.type}::notification_type, ${input.projectId},
           ${v.title}, ${v.preview}, ${input.resourceType}, ${input.resourceId}, ${input.deepLink},
           ${input.actor?.type ?? null}::principal_type, ${input.actor?.id ?? null}::uuid,
           ${v.requiresAction}, ${v.dedupeKey}
      FROM project_members pm
      JOIN org_memberships om ON om.org_id = pm.org_id AND om.user_id = pm.user_id
                             AND om.status = 'active'
     WHERE pm.project_id = ${input.projectId}
       AND pm.user_id IS DISTINCT FROM ${v.actorUser}::uuid
       ${filter}
    ON CONFLICT (user_id, dedupe_key) DO NOTHING`.execute(tx);
}

/** Marks the action notifications about a resource done (e.g. a gate that was decided). */
export async function resolveNotifications(
  tx: Tx,
  input: { projectId: string; resourceId: string },
): Promise<void> {
  await sql`
    UPDATE notifications SET resolved_at = now()
     WHERE project_id = ${input.projectId} AND resource_id = ${input.resourceId}
       AND requires_action AND resolved_at IS NULL`.execute(tx);
}
