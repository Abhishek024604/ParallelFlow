import { sql } from 'kysely';
import { SYSTEM_USER_ID } from './context.js';
import type { Tx } from './database.js';

// The arena's event stream (ADR-044): one audit_events row per change to an arena, written in the
// caller's transaction so the event exists exactly when the change does. Shared by the API and App
// Tools. The row's id, prev_hash and hash are set by the database (0016 trigger), never here.
// Metadata holds ids, names, counts and refs only: never message or file content (CLAUDE.md rule 7).
// Nothing here logs.

/** `<area>.<thing>.<verb>`. The log groups by area (team, loop, file, repo, ai, arena). */
export type ArenaEventAction =
  // Team
  | 'team.member.invited'
  | 'team.member.joined'
  | 'team.member.removed'
  | 'team.member.left'
  | 'team.role.assigned'
  | 'team.role.unassigned'
  | 'team.role.created'
  | 'team.role.updated'
  | 'team.role.deleted'
  | 'team.roles.template_applied'
  | 'team.join_link.reset'
  // Loop
  | 'loop.cycle.started'
  | 'loop.cycle.closed'
  | 'loop.stage.moved'
  | 'loop.stage.sent_back'
  | 'loop.gate.requested'
  | 'loop.gate.voted'
  | 'loop.gate.approved'
  | 'loop.gate.rejected'
  | 'loop.gate_policy.updated'
  // Files
  | 'file.uploaded'
  | 'file.created'
  | 'file.version_added'
  | 'file.renamed'
  | 'file.moved'
  | 'file.deleted'
  | 'file.restored'
  | 'file.approved'
  | 'file.pushed_from_private'
  | 'file.copied_to_private'
  // Code
  | 'repo.connected'
  | 'repo.disconnected'
  | 'repo.synced'
  | 'repo.commit.pushed'
  | 'repo.branch.pushed'
  | 'repo.pr.opened'
  | 'repo.pr.updated'
  | 'repo.pr.merged'
  | 'repo.pr.closed'
  | 'repo.pr.reopened'
  | 'repo.review.submitted'
  // AI
  | 'ai.file.drafted'
  | 'ai.gate.requested'
  | 'ai.tool.denied'
  // Settings
  | 'arena.created'
  | 'arena.updated'
  | 'arena.archived'
  | 'arena.unarchived'
  | 'arena.ai_key.set'
  | 'arena.ai_key.removed';

export type ArenaEventTarget =
  | 'arena'
  | 'user'
  | 'invitation'
  | 'role'
  | 'cycle'
  | 'approval'
  | 'gate_policy'
  | 'file'
  | 'folder'
  | 'repository'
  | 'branch'
  | 'pull_request'
  | 'ai_key'
  | 'tool';

/** Who did it. `service`: ParallelFlow itself or an outside system (GitHub), named by `label`. */
export type EventActor =
  | { type: 'user'; id: string }
  | { type: 'agent'; id: string; onBehalfOf?: string | null }
  | { type: 'service'; label?: string };

type MetaScalar = string | number | boolean | null;
export type EventMetadata = Readonly<
  Record<string, MetaScalar | undefined | readonly MetaScalar[]>
>;

export interface ArenaEventInput {
  action: ArenaEventAction;
  target: { type: ArenaEventTarget; id: string };
  metadata?: EventMetadata;
  requestId?: string | null;
}

export interface ArenaEventScope {
  orgId: string;
  projectId: string;
}

/** Longest metadata string kept (names, titles, branches); longer ones are cut. */
export const EVENT_META_MAX_CHARS = 200;
const MAX_KEYS = 20;
const MAX_ITEMS = 20;

const clip = (v: MetaScalar): MetaScalar =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, EVENT_META_MAX_CHARS) : v;

/**
 * Metadata as stored: scalars and short scalar lists only (no nested objects, so no document can
 * ride along), strings collapsed to one line and cut, undefined dropped, at most 20 keys.
 */
export function cleanMetadata(meta: EventMetadata | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (value === undefined) continue;
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (Array.isArray(value)) {
      out[key] = (value as readonly MetaScalar[]).slice(0, MAX_ITEMS).map((v) => {
        if (v !== null && typeof v === 'object') throw new Error('Event metadata must be flat');
        return clip(v);
      });
    } else if (value !== null && typeof value === 'object') {
      throw new Error('Event metadata must be flat');
    } else {
      out[key] = clip(value as MetaScalar);
    }
  }
  return out;
}

type Listener = (scope: ArenaEventScope) => void;
let listener: Listener | null = null;

/**
 * The API's hook (the activity log's debounce): told after each recorded event, in the writer's
 * transaction (it must only schedule work, never read). Other processes (App Tools) set none.
 */
export function setArenaEventListener(fn: Listener | null): void {
  listener = fn;
}

/** Records one arena event in the caller's transaction. */
export async function recordArenaEvent(
  tx: Tx,
  scope: ArenaEventScope,
  actor: EventActor,
  input: ArenaEventInput,
): Promise<void> {
  const metadata = cleanMetadata({
    ...input.metadata,
    ...(actor.type === 'service' && actor.label ? { actor_label: actor.label } : {}),
  });
  const actorId = actor.type === 'service' ? SYSTEM_USER_ID : actor.id;
  const onBehalfOf = actor.type === 'agent' ? (actor.onBehalfOf ?? null) : null;
  // No RETURNING: the row is readable only under the members policy, which a writer may not pass
  // (a webhook's system job does; a person leaving the arena does not).
  await sql`
    INSERT INTO audit_events (org_id, project_id, actor_type, actor_id, on_behalf_of, action,
                              target_type, target_id, outcome, metadata, request_id, hash)
    VALUES (${scope.orgId}, ${scope.projectId}, ${actor.type}::principal_type, ${actorId},
            ${onBehalfOf}, ${input.action}, ${input.target.type}, ${input.target.id}, 'ok',
            ${JSON.stringify(metadata)}::jsonb, ${input.requestId ?? null}, '\\x'::bytea)`.execute(
    tx,
  );
  try {
    listener?.(scope);
  } catch {
    // A listener never fails the change.
  }
}
