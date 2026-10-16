import type { Database, Tx } from '@saras/db';
import {
  type ArenaTurn,
  PRIVATE_ORG_ID,
  type PrivateMessage,
  type AiSkipped,
  uuidv7,
} from '@saras/contracts';
import { sql } from 'kysely';
import type { AiTurnLimiter } from '../agent/broadcaster.js';
import type { PrivateTurnJob, TurnContext, TurnOutcome, TurnStore } from '../agent/turn-runner.js';
import { insertPrivateAgentMessage } from './chats.js';

// The AI in a private chat (build step 5, ADR-034). Every message in a private chat goes to the
// owner's personal agent (openapi sendPrivateMessage: "starts a turn"). The personal agent and the
// chat's agent session are created on first use, with no org. The turn runs on the same runtime
// socket as the arena (TurnRunner); its background writes run in user scope as the owner, never as
// a system job: Private rows have no org, so no system job could reach them anyway.

export const PERSONAL_AGENT_NAME = 'AI';

/** RIC session_key of a private chat: the nil uuid stands in for the org (ADR-034). */
export const privateSessionKey = (userId: string, sessionId: string) =>
  `org/${PRIVATE_ORG_ID}/user/${userId}/private/${sessionId}`;

export interface QueuedPrivateTurn {
  turn: ArenaTurn | null;
  skipped?: AiSkipped;
  job?: PrivateTurnJob;
}

/** The caller's personal agent, created on first use. */
async function personalAgentId(tx: Tx, userId: string): Promise<string> {
  await sql`INSERT INTO agents (id, org_id, kind, owner_user_id, name)
            VALUES (${uuidv7()}, NULL, 'personal', ${userId}, ${PERSONAL_AGENT_NAME})
            ON CONFLICT (owner_user_id) WHERE kind = 'personal' DO NOTHING`.execute(tx);
  const row = await tx
    .selectFrom('agents')
    .select('id')
    .where('kind', '=', 'personal')
    .where('owner_user_id', '=', userId)
    .executeTakeFirstOrThrow();
  return row.id;
}

/** The chat's agent session, created on first use. */
async function agentSessionId(tx: Tx, userId: string, sessionId: string): Promise<string> {
  const agentId = await personalAgentId(tx, userId);
  await sql`INSERT INTO agent_sessions (id, org_id, session_key, kind, private_session_id, agent_id)
            VALUES (${uuidv7()}, NULL, ${privateSessionKey(userId, sessionId)}, 'private',
                    ${sessionId}, ${agentId})
            ON CONFLICT (private_session_id) DO NOTHING`.execute(tx);
  const row = await tx
    .selectFrom('agent_sessions')
    .select('id')
    .where('private_session_id', '=', sessionId)
    .where('kind', '=', 'private')
    .executeTakeFirstOrThrow();
  return row.id;
}

/** Queues the AI's turn for a message the owner just posted (same transaction). */
export async function queuePrivateTurn(
  tx: Tx,
  ctx: { userId: string; sessionId: string },
  message: PrivateMessage,
  limiter: AiTurnLimiter,
): Promise<QueuedPrivateTurn> {
  if (!limiter.tryTake(ctx.userId)) {
    return {
      turn: null,
      skipped: {
        reason: 'rate_limited',
        detail:
          'Your message was saved. You have asked the AI a lot this minute; try again shortly.',
      },
    };
  }
  const session = await agentSessionId(tx, ctx.userId, ctx.sessionId);
  const id = uuidv7();
  const row = await tx
    .insertInto('runtime_turns')
    .values({
      id,
      org_id: null,
      agent_session_id: session,
      trigger_message_id: message.id,
      requested_by: ctx.userId,
      mode: 'prompt',
    })
    .returning(['queued_at'])
    .executeTakeFirstOrThrow();
  return {
    turn: {
      id,
      status: 'queued',
      mode: 'prompt',
      failure_code: null,
      queued_at: new Date(row.queued_at as unknown as string | Date).toISOString(),
      finished_at: null,
    },
    job: {
      kind: 'private',
      turnId: id,
      privateSessionId: ctx.sessionId,
      messageId: message.id,
      userId: ctx.userId,
      text: message.body,
    },
  };
}

/**
 * Background writes of a private turn, in user scope as the chat's owner (db.withUser). Every query
 * is also filtered by the turn's ids. RLS shows only the owner's Private rows.
 */
export class PrivateTurnStore implements TurnStore {
  constructor(private readonly db: Database) {}

  private asOwner<T>(job: PrivateTurnJob, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.withUser({ userId: job.userId }, fn);
  }

  begin(job: PrivateTurnJob): Promise<TurnContext> {
    return this.asOwner(job, async (tx) => {
      const turn = await tx
        .updateTable('runtime_turns')
        .set({ status: 'running' })
        .where('id', '=', job.turnId)
        .where('status', '=', 'queued')
        .where('org_id', 'is', null)
        .returning('agent_session_id')
        .executeTakeFirst();
      if (!turn) throw new Error('Turn is not queued');
      const session = await tx
        .selectFrom('agent_sessions as s')
        .innerJoin('agents as a', 'a.id', 's.agent_id')
        .select(['s.id', 's.session_key', 's.runtime_session_id', 'a.id as agent_id', 'a.name'])
        .where('s.id', '=', turn.agent_session_id)
        .where('s.private_session_id', '=', job.privateSessionId)
        .executeTakeFirstOrThrow();
      const me = await tx
        .selectFrom('users')
        .select('display_name')
        .where('id', '=', job.userId)
        .executeTakeFirst();
      return {
        agentSessionId: session.id,
        sessionKey: session.session_key,
        runtimeSessionId: session.runtime_session_id,
        agent: { id: session.agent_id, name: session.name },
        // A private chat carries no arena data (unlinked; the bridge is step 6).
        project: { name: '', description: null },
        members: [],
        author: { display_name: me?.display_name ?? 'You', roles: [] },
        autonomy: {},
        cycle: null,
      };
    });
  }

  async saveRuntimeSession(
    job: PrivateTurnJob,
    agentSessionId: string,
    runtimeSessionId: string,
  ): Promise<void> {
    await this.asOwner(job, (tx) =>
      tx
        .updateTable('agent_sessions')
        .set({ runtime_session_id: runtimeSessionId, status: 'ready' })
        .where('id', '=', agentSessionId)
        .where('private_session_id', '=', job.privateSessionId)
        .execute(),
    );
  }

  insertAgentMessage(job: PrivateTurnJob, agentId: string, text: string): Promise<string> {
    return this.asOwner(job, (tx) =>
      insertPrivateAgentMessage(tx, {
        sessionId: job.privateSessionId,
        agentId,
        turnId: job.turnId,
        body: text,
      }),
    );
  }

  async finish(job: PrivateTurnJob, outcome: TurnOutcome): Promise<void> {
    await this.asOwner(job, async (tx) => {
      await tx
        .updateTable('runtime_turns')
        .set({
          status: outcome.status,
          failure_code: outcome.failureCode,
          usage: JSON.stringify(outcome.usage ?? {}),
          finished_at: sql<Date>`now()`,
        })
        .where('id', '=', job.turnId)
        .where('org_id', 'is', null)
        .execute();
      await sql`UPDATE agent_sessions SET last_turn_at = now()
                 WHERE private_session_id = ${job.privateSessionId}`.execute(tx);
    });
  }
}
