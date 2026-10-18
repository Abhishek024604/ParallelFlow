import {
  type AiSkipped,
  type ArenaMessage,
  type ArenaTurn,
  aiCommandText,
  mentionsAi,
  uuidv7,
} from '@saras/contracts';
import type { Tx } from '@saras/db';
import { sql } from 'kysely';
import { hasCapability } from '../arenas/messages.js';
import type { AiTurnLimiter, TurnBroadcaster } from './broadcaster.js';
import { type TurnJob, type TurnRunner, turnText, withContextFirst } from './turn-runner.js';

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

/** RIC input.text maxLength. */
const TURN_TEXT_MAX = 20_000;

/**
 * @AI inside a thread: the turn text starts with the thread's first message and its latest replies
 * (data for the AI, never shown), so the AI answers in context.
 */
async function threadText(tx: Tx, message: ArenaMessage, text: string): Promise<string> {
  if (!message.parent_id) return text;
  const { rows } = await sql<{ name: string; body: string; at: string }>`
    SELECT CASE WHEN m.author_type = 'user' THEN COALESCE(u.display_name, 'Teammate') ELSE 'AI' END
             AS name, m.body, m.created_at::text AS at
      FROM messages m
      LEFT JOIN users u ON m.author_type = 'user' AND u.id = m.author_id
     WHERE m.arena_id = ${message.arena_id} AND m.deleted_at IS NULL AND m.id <> ${message.id}
       AND (m.id = ${message.parent_id} OR m.parent_id = ${message.parent_id})
     ORDER BY m.id = ${message.parent_id} DESC, m.created_at DESC, m.id DESC
     LIMIT 11`.execute(tx);
  if (rows.length === 0) return text;
  const clip = (body: string) => (body.length > 1_500 ? `${body.slice(0, 1_499)}…` : body);
  const lines = rows
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((r) => `${r.name}: ${clip(r.body)}`);
  const room = TURN_TEXT_MAX - text.length - 100;
  if (room < 200) return text;
  let context = lines.join('\n');
  if (context.length > room) context = `…${context.slice(context.length - room + 1)}`;
  return withContextFirst(
    text,
    `[This message is a reply in a thread. The thread so far:\n${context}]`,
  );
}

/**
 * Queues a turn when `message` asks @AI (or starts with an AI command, "/spec …") and the sender may
 * invoke it. `force` (an answer to the AI's question) queues one without "@AI", with `text` as what
 * the AI reads.
 */
export async function queueAiTurn(
  tx: Tx,
  ctx: { projectId: string; orgId: string; userId: string },
  message: ArenaMessage,
  limiter: AiTurnLimiter,
  options: { force?: boolean; text?: string } = {},
): Promise<QueuedTurn> {
  const command = aiCommandText(message.body, 'arena');
  if (!options.force && !command && !mentionsAi(message.body)) return { turn: null };
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
      parentId: message.parent_id,
      text: await threadText(
        tx,
        message,
        options.text ?? turnText(command ?? message.body, message.attachments),
      ),
    },
  };
}
