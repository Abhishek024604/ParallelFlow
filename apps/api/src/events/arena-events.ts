import {
  type ArenaEventInput,
  type ArenaEventScope,
  type EventActor,
  recordArenaEvent,
  type Tx,
} from '@parallelflow/db';

// Small helpers around packages/db recordArenaEvent (ADR-044) for API code that knows the arena's
// project but not its org: the org is read in the caller's transaction (each arena is one org,
// ADR-029). Events are always written in the transaction of the change they describe.

/** The arena's org and project, read in the caller's transaction. */
export async function arenaScope(tx: Tx, projectId: string): Promise<ArenaEventScope> {
  const row = await tx
    .selectFrom('projects')
    .select('org_id')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow();
  return { orgId: row.org_id, projectId };
}

export const userActor = (id: string): EventActor => ({ type: 'user', id });

/** recordArenaEvent for a person, when only the project is known. */
export async function recordUserEvent(
  tx: Tx,
  projectId: string,
  userId: string,
  input: ArenaEventInput,
): Promise<void> {
  await recordArenaEvent(tx, await arenaScope(tx, projectId), userActor(userId), input);
}
