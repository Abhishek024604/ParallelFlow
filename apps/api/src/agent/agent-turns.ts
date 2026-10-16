import {
  type AiSkipped,
  type ArenaMessage,
  type ArenaTurn,
  mentionsAi,
  uuidv7,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { hasCapability } from '../arenas/messages.js';
import type { AiTurnLimiter, TurnBroadcaster } from './broadcaster.js';
import type { TurnJob, TurnRunner } from './turn-runner.js';

// @AI in the arena (build step 4): queueing a turn inside the POST message transaction. The turn row
// commits with the message; the runner starts once both have committed (AfterCommit).

export const AGENT_TURNS = Symbol('AGENT_TURNS');
export const AGENT_INVOKE = 'agent.invoke';

export interface AgentTurns {
  runner: TurnRunner;
  broadcaster: TurnBroadcaster;
  limiter: AiTurnLimiter;
}

export interface QueuedTurn {
  turn: ArenaTurn | null;
  skipped?: AiSkipped;
  job?: TurnJob;
}

/** Queues a turn when `message` asks @AI and the sender may invoke it. */
export async function queueAiTurn(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  message: ArenaMessage,
  limiter: AiTurnLimiter,
): Promise<QueuedTurn> {
  if (!mentionsAi(message.body)) return { turn: null };
  if (!(await hasCapability(tx, ctx.projectId, ctx.userId, AGENT_INVOKE))) {
    return {
      turn: null,
      skipped: {
        reason: 'not_allowed',
        detail: "Your message was sent, but you can't ask the AI here.",
      },
    };
  }
  if (!limiter.tryTake(ctx.userId)) {
    return {
      turn: null,
      skipped: {
        reason: 'rate_limited',
        detail:
          'Your message was sent. You have asked the AI a lot this minute; try again shortly.',
      },
    };
  }
  const session = await tx
    .selectFrom('agent_sessions')
    .select('id')
    .where('arena_id', '=', message.arena_id)
    .where('kind', '=', 'arena')
    .executeTakeFirstOrThrow();
  const id = uuidv7();
  const row = await tx
    .insertInto('runtime_turns')
    .values({
      id,
      org_id: ctx.orgId,
      agent_session_id: session.id,
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
      turnId: id,
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      arenaId: message.arena_id,
      messageId: message.id,
      userId: ctx.userId,
      text: message.body,
    },
  };
}
