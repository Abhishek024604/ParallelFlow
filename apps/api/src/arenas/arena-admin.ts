import type { ArenaSummary, UpdateArena } from '@parallelflow/contracts';
import { softDelete, type Tx } from '@parallelflow/db';
import { sql } from 'kysely';
import { recordUserEvent } from '../events/arena-events.js';
import { ApiError, notFound } from '../pipeline/errors.js';
import { arenaSummary } from './arenas.js';

// Owner-only arena actions (ADR-038): rename, archive / unarchive, delete. `tx` is the verified
// tenant context of the arena's org (@ProjectScoped). An archived arena is read-only and stays in
// the list under Archived; a deleted arena is soft-deleted (projects.deleted_at) and RLS hides it.

/** Whether the user holds the arena's Owner role. */
export async function isArenaOwner(tx: Tx, projectId: string, userId: string): Promise<boolean> {
  const row = await tx
    .selectFrom('project_member_roles as pmr')
    .innerJoin('project_roles as r', 'r.id', 'pmr.role_id')
    .select('pmr.user_id')
    .where('pmr.project_id', '=', projectId)
    .where('pmr.user_id', '=', userId)
    .where('r.system_kind', '=', 'owner')
    .executeTakeFirst();
  return Boolean(row);
}

/** A clear 403 for anyone but the arena owner. */
export async function requireArenaOwner(
  tx: Tx,
  projectId: string,
  userId: string,
  action: string,
): Promise<void> {
  if (!(await isArenaOwner(tx, projectId, userId))) {
    throw new ApiError(403, 'FORBIDDEN', {
      detail: `Only the arena owner can ${action}.`,
      requiredPermission: 'role owner',
    });
  }
}

/** 409 when the arena is archived: archived arenas are read-only. */
export async function requireActiveArena(tx: Tx, projectId: string): Promise<void> {
  const row = await tx
    .selectFrom('projects')
    .select('status')
    .where('id', '=', projectId)
    .executeTakeFirst();
  if (!row) throw notFound();
  if (row.status === 'archived') {
    throw new ApiError(409, 'CONFLICT', {
      detail: 'This arena is archived and read-only. The owner can unarchive it.',
    });
  }
}

async function summaryOrNotFound(tx: Tx, projectId: string, userId: string): Promise<ArenaSummary> {
  const summary = await arenaSummary(tx, projectId, userId);
  if (!summary) throw notFound();
  return summary;
}

/** PATCH /arenas/{id}: new name and/or description. The key (e.g. "HM") does not change. */
export async function updateArena(
  tx: Tx,
  projectId: string,
  userId: string,
  input: UpdateArena,
): Promise<ArenaSummary> {
  await requireArenaOwner(tx, projectId, userId, 'rename this arena');
  await tx
    .updateTable('projects')
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.timezone !== undefined && { timezone: input.timezone }),
    })
    .where('id', '=', projectId)
    .execute();
  await recordUserEvent(tx, projectId, userId, {
    action: 'arena.updated',
    target: { type: 'arena', id: projectId },
    metadata: {
      name: input.name,
      renamed: input.name !== undefined,
      description_changed: input.description !== undefined,
      ...(input.timezone !== undefined && { timezone: input.timezone }),
    },
  });
  return summaryOrNotFound(tx, projectId, userId);
}

/** POST /arenas/{id}/archive and /unarchive. */
export async function setArchived(
  tx: Tx,
  projectId: string,
  userId: string,
  archived: boolean,
): Promise<ArenaSummary> {
  await requireArenaOwner(
    tx,
    projectId,
    userId,
    archived ? 'archive this arena' : 'unarchive this arena',
  );
  await tx
    .updateTable('projects')
    .set(
      archived
        ? { status: 'archived', archived_at: sql<Date>`now()` }
        : { status: 'active', archived_at: null },
    )
    .where('id', '=', projectId)
    .execute();
  await recordUserEvent(tx, projectId, userId, {
    action: archived ? 'arena.archived' : 'arena.unarchived',
    target: { type: 'arena', id: projectId },
  });
  return summaryOrNotFound(tx, projectId, userId);
}

/** DELETE /arenas/{id}: soft delete. The arena disappears for every member; rows stay for audit. */
export async function deleteArena(tx: Tx, projectId: string, userId: string): Promise<void> {
  await requireArenaOwner(tx, projectId, userId, 'delete this arena');
  await softDelete(tx, 'projects', projectId, userId);
}
