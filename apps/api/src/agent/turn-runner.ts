import { MESSAGE_BODY_MAX_CHARS } from '@saras/contracts';
import type { Logger } from '@saras/observability';
import {
  AUTONOMY_CLASSES,
  type AutonomyPolicy,
  eventErrorCode,
  eventText,
  eventUsage,
  type RuntimeClient,
  RuntimeError,
  type SdlcStage,
  type ToolToken,
  type ToolTokenInput,
  type Usage,
} from '@saras/runtime-client';
import type { TurnBroadcaster } from './broadcaster.js';

// Runs one @AI turn against the external agent runtime (RIC v0.2), after the triggering message has
// committed. The runtime is a socket: with no client configured the turn fails fast with
// RUNTIME_NOT_CONFIGURED and the arena shows "AI isn't connected yet".
//
//   provision session (first use) → createTurn → stream events
//     message.delta     → broadcaster (live text, this instance only)
//     message.completed → AI message in the arena (store, under the arena lock)
//     turn.completed    → usage + completed
//     turn.failed / turn.cancelled / errors → status + failure_code
//
// Logs carry ids, statuses and codes only: never prompts, agent text or tokens (CLAUDE.md rule 7).

export interface TurnJob {
  turnId: string;
  orgId: string;
  projectId: string;
  arenaId: string;
  messageId: string;
  userId: string;
  /** The triggering message body. Kept in memory only. */
  text: string;
}

export interface TurnContext {
  agentSessionId: string;
  sessionKey: string;
  runtimeSessionId: string | null;
  agent: { id: string; name: string };
  project: { name: string; description: string | null };
  /** Members of this arena only (never another project's). */
  members: { user_id: string; display_name: string; roles: string[] }[];
  author: { display_name: string; roles: string[] };
  /** agent_policies rows: class → level. */
  autonomy: Record<string, string>;
  cycle: { number: number; stage: SdlcStage } | null;
}

export interface TurnOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  failureCode: string | null;
  usage?: Usage;
}

/** Persistence for a turn. DbTurnStore in the app; a fake in tests. */
export interface TurnStore {
  /** queued → running and the context to send. Throws if the turn is not queued. */
  begin(job: TurnJob): Promise<TurnContext>;
  saveRuntimeSession(job: TurnJob, agentSessionId: string, runtimeSessionId: string): Promise<void>;
  /** Inserts the AI's arena message (author_type agent, turn_id) and returns its id. */
  insertAgentMessage(job: TurnJob, agentId: string, text: string): Promise<string>;
  finish(job: TurnJob, outcome: TurnOutcome): Promise<void>;
}

export interface TurnRunnerDeps {
  store: TurnStore;
  /** Undefined = no RUNTIME_URL: every turn fails with RUNTIME_NOT_CONFIGURED. */
  client: RuntimeClient | undefined;
  mintToolToken: ((input: ToolTokenInput) => ToolToken) | undefined;
  broadcaster: TurnBroadcaster;
  logger: Logger;
}

/** App Tools the central arena agent may call (app-tools_v0.2.mcp.json); enforced by App Tools later. */
export const CENTRAL_AGENT_SCOPES = [
  'arena.read_history',
  'arena.post_message',
  'project.get_overview',
  'members.list',
  'cycle.get_state',
  'artifacts.list',
  'artifacts.read',
  'artifacts.create_draft',
  'tasks.list',
  'tasks.create_draft',
  'delegation.suggest',
  'stage.request_gate',
  'notify.tag',
  'knowledge.search',
  'approval.request',
] as const;

export const NOT_CONFIGURED = 'RUNTIME_NOT_CONFIGURED';
export const UNREACHABLE = 'RUNTIME_UNREACHABLE';

function autonomyOf(rows: Record<string, string>): AutonomyPolicy {
  const policy: AutonomyPolicy = {};
  for (const cls of AUTONOMY_CLASSES) {
    const level = rows[cls];
    if (level === 'off' || level === 'suggest' || level === 'approve' || level === 'act') {
      policy[cls] = level;
    }
  }
  return policy;
}

function projectBrief(ctx: TurnContext): string {
  return ctx.project.description
    ? `${ctx.project.name}\n\n${ctx.project.description}`
    : ctx.project.name;
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  /** Starts the turn in the background. The broadcaster entry exists before this returns. */
  start(job: TurnJob): void {
    this.deps.broadcaster.open(job.turnId);
    void this.run(job);
  }

  /** The whole turn. Never throws. */
  async run(job: TurnJob): Promise<void> {
    const { client, store } = this.deps;
    this.deps.broadcaster.open(job.turnId);
    if (!client || !this.deps.mintToolToken) {
      await this.finish(job, { status: 'failed', failureCode: NOT_CONFIGURED }, null);
      return;
    }
    let ctx: TurnContext;
    try {
      ctx = await store.begin(job);
    } catch {
      await this.finish(job, { status: 'failed', failureCode: 'INTERNAL' }, null);
      return;
    }

    let accepted = false;
    let messageId: string | null = null;
    let outcome: TurnOutcome | undefined;
    try {
      let sessionId = ctx.runtimeSessionId;
      if (!sessionId) {
        const session = await client.createSession({
          session_key: ctx.sessionKey,
          kind: 'arena',
          scope: { org_id: job.orgId, project_id: job.projectId, user_id: null },
          profile: 'central_arena',
          agent: { id: ctx.agent.id, kind: 'central', display_name: ctx.agent.name },
          context_seed: { project_brief: projectBrief(ctx), members: ctx.members },
          tool_token: this.deps.mintToolToken({
            sessionKey: ctx.sessionKey,
            orgId: job.orgId,
            projectId: job.projectId,
            principal: { type: 'agent', id: ctx.agent.id, kind: 'central' },
            scopes: CENTRAL_AGENT_SCOPES,
          }),
        });
        sessionId = session.session_id;
        await store.saveRuntimeSession(job, ctx.agentSessionId, sessionId);
      }

      await client.createTurn(sessionId, {
        turn_id: job.turnId,
        mode: 'prompt',
        input: {
          author: {
            type: 'user',
            id: job.userId,
            display_name: ctx.author.display_name,
            roles: ctx.author.roles,
          },
          text: job.text,
          message_id: job.messageId,
          mentions: [{ type: 'agent', id: ctx.agent.id }],
        },
        autonomy: autonomyOf(ctx.autonomy),
        reply_expected: true,
        ...(ctx.cycle && { app_state: { cycle_number: ctx.cycle.number, stage: ctx.cycle.stage } }),
      });
      accepted = true;

      for await (const event of client.streamTurnEvents(sessionId, job.turnId)) {
        // Isolation: only this turn's events count.
        if (event.turn_id !== job.turnId) continue;
        switch (event.type) {
          case 'message.delta':
            this.deps.broadcaster.delta(job.turnId, eventText(event));
            break;
          case 'message.completed': {
            const text = eventText(event).trim().slice(0, MESSAGE_BODY_MAX_CHARS);
            if (text && !messageId) {
              messageId = await store.insertAgentMessage(job, ctx.agent.id, text);
            }
            break;
          }
          case 'turn.completed':
            outcome = { status: 'completed', failureCode: null, usage: eventUsage(event) };
            break;
          case 'turn.failed':
            outcome = { status: 'failed', failureCode: eventErrorCode(event) ?? 'RUNTIME_FAILED' };
            break;
          case 'turn.cancelled':
            outcome = { status: 'cancelled', failureCode: 'CANCELLED' };
            break;
          default:
            break;
        }
      }
      outcome ??= { status: 'failed', failureCode: 'STREAM_ENDED' };
    } catch (err) {
      const code =
        err instanceof RuntimeError
          ? err.code === 'NETWORK'
            ? accepted
              ? 'RUNTIME_NETWORK'
              : UNREACHABLE
            : err.code
          : 'INTERNAL';
      outcome = { status: 'failed', failureCode: code };
    }
    await this.finish(job, outcome, messageId);
  }

  private async finish(
    job: TurnJob,
    outcome: TurnOutcome,
    messageId: string | null,
  ): Promise<void> {
    try {
      await this.deps.store.finish(job, outcome);
    } catch {
      this.deps.logger.warn({ turnId: job.turnId }, 'agent turn: could not store the outcome');
    }
    this.deps.broadcaster.finish(job.turnId, {
      type: 'status',
      status: outcome.status,
      failure_code: outcome.failureCode,
      message_id: messageId,
    });
    this.deps.logger.info(
      { turnId: job.turnId, status: outcome.status, failureCode: outcome.failureCode },
      'agent turn finished',
    );
  }
}
