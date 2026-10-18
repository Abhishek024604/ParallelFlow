import { MESSAGE_BODY_MAX_CHARS, PRIVATE_ORG_ID } from '@saras/contracts';
import type { Logger } from '@saras/observability';
import {
  AUTONOMY_CLASSES,
  type AutonomyPolicy,
  type CreateSessionRequest,
  eventArtifact,
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
import { sanitizeAiText, StreamSanitizer } from './output-filter.js';
import { guardReply, type SavedDraft } from './paste-guard.js';

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

interface TurnJobBase {
  turnId: string;
  messageId: string;
  userId: string;
  /** The triggering message body. Kept in memory only. */
  text: string;
}

/** @AI in an arena: the central agent's arena session. */
export interface ArenaTurnJob extends TurnJobBase {
  kind?: 'arena';
  orgId: string;
  projectId: string;
  arenaId: string;
  /**
   * `progress`: a progress-log turn in the same arena session (progress/). Its reply is returned
   * to the caller (runCaptured) instead of being posted, it streams to no one, it gets read-only
   * tools, and drafts it proposes are ignored.
   */
  purpose?: 'reply' | 'progress';
}

/** A private chat (ADR-034): the owner's personal agent, no org, no project. */
export interface PrivateTurnJob extends TurnJobBase {
  kind: 'private';
  privateSessionId: string;
}

export type TurnJob = ArenaTurnJob | PrivateTurnJob;

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
  /**
   * A linked private chat's read-only snapshot of its one arena (the bridge, ADR-034). Never set for
   * an arena turn or an unlinked chat.
   */
  bridge?: {
    brief: string;
    text: string;
    attachments: { artifact_id: string; version_no: number; name: string }[];
  };
}

export interface TurnOutcome {
  status: 'completed' | 'failed' | 'cancelled';
  failureCode: string | null;
  usage?: Usage;
}

/**
 * Persistence for a turn. DbTurnStore in the app; a fake in tests. For a private job the store
 * returns an empty project, members, autonomy and cycle: a private chat carries no arena data.
 */
export interface TurnStore {
  /** queued → running and the context to send. Throws if the turn is not queued. */
  begin(job: TurnJob): Promise<TurnContext>;
  saveRuntimeSession(job: TurnJob, agentSessionId: string, runtimeSessionId: string): Promise<void>;
  /**
   * Inserts the AI's message (author_type agent, turn_id) in the job's stream, with the documents
   * the turn saved as `artifact_refs`; returns its id.
   */
  insertAgentMessage(
    job: TurnJob,
    agentId: string,
    text: string,
    artifactRefs?: string[],
  ): Promise<string>;
  /**
   * artifact.proposed: stores a draft artifact in the job's home (arena, or the private chat).
   * Returns the artifact and its new version, or null when the proposal was dropped.
   */
  saveProposedArtifact?(
    job: TurnJob,
    agentId: string,
    proposal: { name: string; kind: string; content: string },
  ): Promise<{ id: string; versionNo: number } | null>;
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

/** App Tools the central arena agent may call (app-tools_v0.2.mcp.json); App Tools enforces them (ADR-035). */
export const CENTRAL_AGENT_SCOPES = [
  'arena.read_history',
  'arena.post_message',
  'project.get_overview',
  'members.list',
  'cycle.get_state',
  'artifacts.list',
  'artifacts.read',
  'artifacts.create_draft',
  'files.list',
  'files.read',
  'tasks.list',
  'tasks.create_draft',
  'delegation.suggest',
  'stage.request_gate',
  'notify.tag',
  'knowledge.search',
  'approval.request',
] as const;

/** Read-only App Tools for a progress-log turn: it reads the arena and writes nothing. */
export const PROGRESS_AGENT_SCOPES = [
  'arena.read_history',
  'project.get_overview',
  'members.list',
  'cycle.get_state',
  'artifacts.list',
  'artifacts.read',
  'files.list',
  'files.read',
  'knowledge.search',
] as const;

const isCaptured = (job: TurnJob): boolean => job.kind !== 'private' && job.purpose === 'progress';

/**
 * App Tools the personal agent may call in a private chat (ADR-035): save a private draft (delivered
 * as artifact.proposed), read the owner's own files and artifacts, and search the owner's own chats.
 * Arena context still arrives as the bridge snapshot in the turn input.
 */
export const PERSONAL_AGENT_SCOPES = [
  'private.save_artifact',
  'private.list_artifacts',
  'private.read_artifact',
  'files.list',
  'files.read',
  'knowledge.search',
] as const;

/**
 * The turn text for a message: its body, then the files attached to it by name and id, so the AI
 * can open them with files.read. The stored message is unchanged.
 */
export function turnText(
  body: string,
  attachments: readonly { file_id: string; name: string }[],
): string {
  if (!attachments.length) return body;
  const files = attachments.map((f) => `${f.name} (file_id ${f.file_id})`).join(', ');
  return `${body}\n\n[Attached files: ${files}. Read them with files.read.]`;
}

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

/** RIC input.text maxLength. */
const TURN_TEXT_MAX_CHARS = 20_000;

/**
 * The turn text with a linked chat's arena snapshot in front, cut so the whole stays within the RIC
 * limit (the person's own words are never cut).
 */
export function withBridgeContext(text: string, ctx: Pick<TurnContext, 'bridge'>): string {
  if (!ctx.bridge) return text;
  const room = TURN_TEXT_MAX_CHARS - text.length - 2;
  if (room < 200) return text;
  const context =
    ctx.bridge.text.length <= room ? ctx.bridge.text : `${ctx.bridge.text.slice(0, room - 1)}…`;
  return `${context}\n\n${text}`;
}

function projectBrief(ctx: TurnContext): string {
  return ctx.project.description
    ? `${ctx.project.name}\n\n${ctx.project.description}`
    : ctx.project.name;
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  /** A fresh App Tools token for the job's session (≤ 60 min; sent on create and before every turn). */
  private toolToken(job: TurnJob, ctx: TurnContext): ToolToken {
    const mint = this.deps.mintToolToken;
    if (!mint) throw new Error('No tool token minter');
    if (job.kind === 'private') {
      return mint({
        sessionKey: ctx.sessionKey,
        orgId: PRIVATE_ORG_ID,
        projectId: null,
        principal: { type: 'agent', id: ctx.agent.id, kind: 'personal', on_behalf_of: job.userId },
        scopes: PERSONAL_AGENT_SCOPES,
      });
    }
    return mint({
      sessionKey: ctx.sessionKey,
      orgId: job.orgId,
      projectId: job.projectId,
      principal: { type: 'agent', id: ctx.agent.id, kind: 'central' },
      scopes: isCaptured(job) ? PROGRESS_AGENT_SCOPES : CENTRAL_AGENT_SCOPES,
    });
  }

  /** RIC CreateSession for the job's session (first use). */
  private sessionRequest(job: TurnJob, ctx: TurnContext): CreateSessionRequest {
    if (job.kind === 'private') {
      // ADR-034: Private has no org; the RIC org uuid is the nil uuid. No arena data in the seed.
      return {
        session_key: ctx.sessionKey,
        kind: 'private',
        scope: { org_id: PRIVATE_ORG_ID, project_id: null, user_id: job.userId },
        profile: 'personal_private',
        agent: {
          id: ctx.agent.id,
          kind: 'personal',
          display_name: ctx.agent.name,
          on_behalf_of: job.userId,
        },
        context_seed: ctx.bridge ? { project_brief: ctx.bridge.brief } : {},
        tool_token: this.toolToken(job, ctx),
      };
    }
    return {
      session_key: ctx.sessionKey,
      kind: 'arena',
      scope: { org_id: job.orgId, project_id: job.projectId, user_id: null },
      profile: 'central_arena',
      agent: { id: ctx.agent.id, kind: 'central', display_name: ctx.agent.name },
      context_seed: { project_brief: projectBrief(ctx), members: ctx.members },
      tool_token: this.toolToken(job, ctx),
    };
  }

  /** Starts the turn in the background. The broadcaster entry exists before this returns. */
  start(job: TurnJob): void {
    this.deps.broadcaster.open(job.turnId);
    void this.run(job);
  }

  /** The whole turn. Never throws. */
  async run(job: TurnJob): Promise<void> {
    await this.execute(job);
  }

  /**
   * A progress turn (job.purpose 'progress'): the AI's reply text, or null when the turn did not
   * complete with one. Never throws.
   */
  async runCaptured(job: ArenaTurnJob): Promise<string | null> {
    const { outcome, text } = await this.execute({ ...job, purpose: 'progress' });
    return outcome.status === 'completed' ? text : null;
  }

  private async execute(job: TurnJob): Promise<{ outcome: TurnOutcome; text: string | null }> {
    const { client, store } = this.deps;
    const captured = isCaptured(job);
    if (!captured) this.deps.broadcaster.open(job.turnId);
    if (!client || !this.deps.mintToolToken) {
      const failed: TurnOutcome = { status: 'failed', failureCode: NOT_CONFIGURED };
      await this.finish(job, failed, null);
      return { outcome: failed, text: null };
    }
    let ctx: TurnContext;
    try {
      ctx = await store.begin(job);
    } catch {
      const failed: TurnOutcome = { status: 'failed', failureCode: 'INTERNAL' };
      await this.finish(job, failed, null);
      return { outcome: failed, text: null };
    }

    let accepted = false;
    let messageId: string | null = null;
    let capturedText: string | null = null;
    let outcome: TurnOutcome | undefined;
    // Documents this turn saved (latest version per artifact; content kept in memory only).
    const drafts = new Map<string, SavedDraft>();
    try {
      let sessionId = ctx.runtimeSessionId;
      // Tool tokens live ≤ 60 min and the runtime keeps none across a restart: hand the session a
      // fresh one before every turn. A runtime that lost the session (data wiped) gets it re-created.
      if (sessionId && client.rotateToolToken) {
        try {
          await client.rotateToolToken(sessionId, this.toolToken(job, ctx));
        } catch (err) {
          if (!(err instanceof RuntimeError && err.code === 'NOT_FOUND')) throw err;
          sessionId = null;
        }
      }
      if (!sessionId) {
        const session = await client.createSession(this.sessionRequest(job, ctx));
        sessionId = session.session_id;
        await store.saveRuntimeSession(job, ctx.agentSessionId, sessionId);
      }

      await client.createTurn(sessionId, {
        turn_id: job.turnId,
        mode: 'prompt',
        input: {
          author: captured
            ? { type: 'system', id: job.userId, display_name: 'Saras' }
            : {
                type: 'user',
                id: job.userId,
                display_name: ctx.author.display_name,
                roles: ctx.author.roles,
              },
          text: withBridgeContext(job.text, ctx),
          ...(!captured && { message_id: job.messageId }),
          mentions: [{ type: 'agent', id: ctx.agent.id }],
          ...(ctx.bridge?.attachments.length && { attachments: ctx.bridge.attachments }),
        },
        autonomy: autonomyOf(ctx.autonomy),
        reply_expected: true,
        ...(ctx.cycle && { app_state: { cycle_number: ctx.cycle.number, stage: ctx.cycle.stage } }),
      });
      accepted = true;

      // AI text is filtered (ids, secrets, tool names) before it is streamed or stored.
      const live = new StreamSanitizer();
      for await (const event of client.streamTurnEvents(sessionId, job.turnId)) {
        // Isolation: only this turn's events count.
        if (event.turn_id !== job.turnId) continue;
        switch (event.type) {
          case 'message.delta':
            if (!captured) this.deps.broadcaster.delta(job.turnId, live.push(eventText(event)));
            break;
          case 'message.completed': {
            if (captured) {
              capturedText ??= sanitizeAiText(eventText(event).trim()).trim() || null;
              break;
            }
            this.deps.broadcaster.delta(job.turnId, live.flush());
            const saved = [...drafts.values()];
            const text = guardReply(sanitizeAiText(eventText(event).trim()).trim(), saved).slice(
              0,
              MESSAGE_BODY_MAX_CHARS,
            );
            if (text && !messageId) {
              messageId = await store.insertAgentMessage(
                job,
                ctx.agent.id,
                text,
                saved.map((d) => d.artifactId),
              );
            }
            break;
          }
          case 'artifact.proposed': {
            const proposal = eventArtifact(event);
            if (proposal && store.saveProposedArtifact && !captured) {
              try {
                const saved = await store.saveProposedArtifact(job, ctx.agent.id, proposal);
                if (saved) {
                  drafts.delete(saved.id);
                  drafts.set(saved.id, {
                    artifactId: saved.id,
                    name: proposal.name.trim(),
                    versionNo: saved.versionNo,
                    content: proposal.content,
                  });
                }
              } catch {
                this.deps.logger.warn(
                  { turnId: job.turnId },
                  'agent turn: could not store a draft',
                );
              }
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
    return { outcome, text: capturedText };
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
    if (!isCaptured(job))
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
