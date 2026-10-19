import type { Logger } from '@saras/observability';
import type {
  CreateSessionRequest,
  CreateTurnRequest,
  RicError,
  RuntimeErrorCode,
  Session,
  ToolToken,
  Turn,
  TurnStatus,
} from '@saras/runtime-client';
import type { AskedQuestion, SarasTurnContext } from '@saras/pi-saras';
import type { AgentEngine, AgentHandle, AgentTool } from './agent.js';
import type { ArtifactProposal, QuestionProposal, ToolSet, ToolSource } from './app-tools.js';
import { TurnEventLog } from './event-log.js';
import { TurnMapper } from './mapping.js';
import {
  HIDDEN_APP_TOOLS,
  isProfile,
  planTurn,
  type ProfileName,
  sessionContext,
  type TurnExtras,
} from './profiles.js';
import { type SessionMeta, sessionIdFor, type SessionStore } from './store.js';

// The RIC v0.2 behaviour, independent of HTTP (ADR-035). Isolation rules:
//   1. one harness session per session_key, its own folder and Pi session file; nothing shared;
//   2. a session only ever gets its own scope's content (the app sends it; App Tools enforce it);
//   3. a session's tool token must name that session (checked on create, bind and rotate);
//   4. turn_id is idempotent per session;
//   5. events never carry tokens or secrets;
//   6. an ephemeral fork (summaries) runs on an in-memory copy of the session's own history, with its
//      own tool token for the same session_key; it never writes to the session.
// Logs: ids, event types, counts and latency only.

export class RicHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: RuntimeErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'RicHttpError';
  }

  get body(): RicError {
    return { code: this.code, message: this.message, retryable: this.retryable };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_KEY =
  /^org\/([0-9a-f-]{36})\/(?:project\/([0-9a-f-]{36})\/arena|user\/([0-9a-f-]{36})\/private\/[0-9a-f-]{36})$/;
const MODES = new Set(['prompt', 'steer', 'follow_up', 'system', 'routine', 'assignment']);
const TEXT_MAX = 20_000;
export const DEFAULT_TURN_TIMEOUT_S = 300;

const invalid = (message: string) => new RicHttpError(422, 'INVALID_INPUT', message);
const notFound = (what: string) => new RicHttpError(404, 'NOT_FOUND', `${what} not found`);

interface TurnState {
  turnId: string;
  status: TurnStatus;
  failure?: RicError;
  usage?: Turn['usage'];
  log: TurnEventLog;
  mapper?: TurnMapper;
}

interface SessionState {
  meta: SessionMeta;
  token: ToolToken | undefined;
  handle?: AgentHandle;
  toolSet?: ToolSet;
  /** True when the handle was built without tools (App Tools down): rebuilt on the next turn. */
  degradedTools?: boolean;
  turns: Map<string, TurnState>;
  active: TurnState | null;
  /** follow_up turns waiting for the active one, oldest first (each runs as its own prompt). */
  queue: { turn: TurnState; req: CreateTurnRequest }[];
  /** The running turn's data for the Saras extension (sections, autonomy, routing). */
  turnContext?: SarasTurnContext;
  approvals: Map<string, { decision: string; decided_by?: string }>;
}

/** App Tools the runtime shows the model (ask.question is replaced by the extension's ask_user). */
function visibleTools(toolSet: ToolSet | undefined): AgentTool[] {
  if (!toolSet) return [];
  return toolSet.tools.filter((t) => !HIDDEN_APP_TOOLS.has(toolSet.names.get(t.name) ?? t.name));
}

export interface RuntimeServiceDeps {
  engine: AgentEngine;
  tools: ToolSource;
  store: SessionStore;
  logger: Logger;
  clock?: () => number;
  /** How long finished turns' event logs are kept for resume. */
  eventTtlMs?: number;
}

/** The JWT payload of a tool token, decoded without verification (App Tools verifies it). */
function tokenSessionKey(token: ToolToken): string | null {
  try {
    const payload = token.token.split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      session_key?: unknown;
    };
    return typeof claims.session_key === 'string' ? claims.session_key : null;
  } catch {
    return null;
  }
}

function validToolToken(value: unknown): value is ToolToken {
  const t = value as ToolToken | undefined;
  return (
    !!t &&
    typeof t.token === 'string' &&
    t.token.length > 0 &&
    typeof t.expires_at === 'string' &&
    typeof t.mcp_url === 'string' &&
    /^https?:\/\//.test(t.mcp_url)
  );
}

export class RuntimeService {
  private readonly sessions = new Map<string, SessionState>();
  private readonly clock: () => number;
  private readonly eventTtlMs: number;

  constructor(private readonly deps: RuntimeServiceDeps) {
    this.clock = deps.clock ?? Date.now;
    this.eventTtlMs = deps.eventTtlMs ?? 15 * 60_000;
  }

  // ------------------------------------------------------------------ sessions

  createSession(body: unknown): { status: 200 | 201; session: Session } {
    const req = body as CreateSessionRequest;
    if (!req || typeof req !== 'object') throw invalid('Body must be an object');
    const match = typeof req.session_key === 'string' ? SESSION_KEY.exec(req.session_key) : null;
    if (!match) throw invalid('session_key does not match the contract pattern');
    if (req.kind !== 'arena' && req.kind !== 'private') throw invalid('kind');
    if (!req.scope || !UUID.test(String(req.scope.org_id))) throw invalid('scope.org_id');
    if (match[1] !== req.scope.org_id) throw invalid('session_key and scope.org_id differ');
    const isArena = match[2] !== undefined;
    if (isArena !== (req.kind === 'arena')) throw invalid('session_key and kind differ');
    if (isArena && req.scope.project_id !== match[2]) {
      throw new RicHttpError(422, 'SCOPE_MISMATCH', 'scope.project_id must be the arena project');
    }
    if (!isArena && req.scope.project_id) {
      throw new RicHttpError(422, 'SCOPE_MISMATCH', 'A private session starts unbound');
    }
    if (typeof req.profile !== 'string' || !isProfile(req.profile)) {
      throw new RicHttpError(422, 'PROFILE_UNKNOWN', 'Unknown profile');
    }
    const agent = req.agent;
    if (!agent || !UUID.test(String(agent.id)) || typeof agent.display_name !== 'string') {
      throw invalid('agent');
    }
    if (agent.kind !== (isArena ? 'central' : 'personal')) throw invalid('agent.kind');
    if (!validToolToken(req.tool_token)) throw invalid('tool_token');
    this.assertTokenFor(req.session_key, req.tool_token);

    const sessionId = sessionIdFor(req.session_key);
    const existing = this.load(sessionId);
    if (existing) {
      const same =
        existing.meta.kind === req.kind &&
        existing.meta.scope.org_id === req.scope.org_id &&
        (existing.meta.scope.project_id ?? null) === (req.scope.project_id ?? null) &&
        existing.meta.agent.id === agent.id &&
        existing.meta.profile === req.profile;
      if (!same) {
        throw new RicHttpError(
          409,
          'SESSION_KEY_CONFLICT',
          'session_key exists with another scope',
        );
      }
      // The newest token wins (the app re-sends create after a runtime restart).
      existing.token = req.tool_token;
      this.deps.logger.info({ sessionId }, 'session exists');
      return { status: 200, session: this.view(existing) };
    }

    const meta: SessionMeta = {
      session_id: sessionId,
      session_key: req.session_key,
      kind: req.kind,
      scope: {
        org_id: req.scope.org_id,
        project_id: req.scope.project_id ?? null,
        user_id: req.scope.user_id ?? null,
      },
      profile: req.profile,
      agent: {
        id: agent.id,
        kind: agent.kind,
        display_name: agent.display_name.slice(0, 80),
        on_behalf_of: agent.on_behalf_of ?? null,
      },
      context_seed: req.context_seed ?? {},
      bound_project_id: null,
      created_at: new Date(this.clock()).toISOString(),
      archived_at: null,
      last_compacted_at: null,
      pending_notes: [],
    };
    this.deps.store.save(meta);
    const state = this.track(meta, req.tool_token);
    this.deps.logger.info({ sessionId, kind: meta.kind }, 'session created');
    return { status: 201, session: this.view(state) };
  }

  getSession(sessionId: string): Session {
    return this.view(this.require(sessionId));
  }

  archiveSession(sessionId: string): void {
    const state = this.require(sessionId);
    if (state.active) this.cancelState(state, state.active);
    state.meta.archived_at ??= new Date(this.clock()).toISOString();
    this.deps.store.save(state.meta);
    this.dropHandle(state);
    state.token = undefined;
    this.deps.logger.info({ sessionId }, 'session archived');
  }

  bind(sessionId: string, body: unknown): Session {
    const state = this.requireOpen(sessionId);
    const req = body as { project_id?: unknown; tool_token?: unknown };
    if (!req || !UUID.test(String(req.project_id))) throw invalid('project_id');
    if (!validToolToken(req.tool_token)) throw invalid('tool_token');
    if (state.meta.kind !== 'private') {
      throw new RicHttpError(409, 'SCOPE_MISMATCH', 'Only a private session can be bound');
    }
    const projectId = String(req.project_id).toLowerCase();
    if (state.meta.bound_project_id && state.meta.bound_project_id !== projectId) {
      throw new RicHttpError(409, 'ALREADY_BOUND', 'This session is already bound to a project');
    }
    this.assertTokenFor(state.meta.session_key, req.tool_token);
    state.meta.bound_project_id = projectId;
    this.deps.store.save(state.meta);
    state.token = req.tool_token;
    // New token scope → new tool list on the next turn.
    if (!state.active) this.dropHandle(state);
    this.deps.logger.info({ sessionId }, 'session bound');
    return this.view(state);
  }

  rotateToken(sessionId: string, body: unknown): void {
    const state = this.requireOpen(sessionId);
    if (!validToolToken(body)) throw invalid('tool token');
    this.assertTokenFor(state.meta.session_key, body);
    state.token = body;
    if (state.degradedTools && !state.active) this.dropHandle(state);
  }

  compact(sessionId: string): void {
    const state = this.requireOpen(sessionId);
    const handle = state.handle;
    if (!handle || state.active) return; // Pi also compacts by itself when the context fills up.
    const started = this.clock();
    handle
      .compact()
      .then(() => {
        state.meta.last_compacted_at = new Date(this.clock()).toISOString();
        this.deps.store.save(state.meta);
        this.deps.logger.info({ sessionId, ms: this.clock() - started }, 'session compacted');
      })
      .catch(() => this.deps.logger.warn({ sessionId }, 'compaction failed'));
  }

  resolveApproval(sessionId: string, approvalId: string, body: unknown): void {
    const state = this.requireOpen(sessionId);
    const req = body as { decision?: unknown; decided_by?: unknown };
    const decision = req?.decision;
    if (decision !== 'approved' && decision !== 'rejected' && decision !== 'expired') {
      throw invalid('decision');
    }
    if (!approvalId || approvalId.length > 100) throw invalid('approval_id');
    // Phase A: the runtime never waits on approvals (App Tools answers APPROVAL_REQUIRED); the
    // decision is stored so a later version can resume the waiting turn (SLICE_DEBT.md).
    state.approvals.set(approvalId, {
      decision,
      ...(typeof req.decided_by === 'string' && { decided_by: req.decided_by }),
    });
  }

  // ------------------------------------------------------------------ turns

  createTurn(sessionId: string, body: unknown): { status: 200 | 202; turn: Turn } {
    const state = this.requireOpen(sessionId);
    this.sweep(state);
    const req = body as CreateTurnRequest;
    if (!req || typeof req !== 'object' || !UUID.test(String(req.turn_id)))
      throw invalid('turn_id');
    const turnId = req.turn_id.toLowerCase();
    const existing = state.turns.get(turnId);
    if (existing) return { status: 200, turn: this.turnView(state, existing) };

    const mode = req.mode ?? 'prompt';
    if (!MODES.has(mode)) throw invalid('mode');
    const input = req.input;
    const author = input?.author;
    if (!author || (author.type !== 'user' && author.type !== 'system')) {
      throw invalid('input.author');
    }
    if (typeof author.id !== 'string' || typeof author.display_name !== 'string') {
      throw invalid('input.author');
    }
    if (typeof input.text !== 'string' || input.text.length > TEXT_MAX) throw invalid('input.text');

    const fork = (req as CreateTurnRequest & TurnExtras).ephemeral_fork === true;
    const forkToken = (req as CreateTurnRequest & { tool_token?: unknown }).tool_token;
    if (fork) {
      if (mode !== 'prompt') throw invalid('An ephemeral fork runs in mode prompt');
      if (forkToken !== undefined) {
        if (!validToolToken(forkToken)) throw invalid('tool_token');
        this.assertTokenFor(state.meta.session_key, forkToken);
      }
    }

    const running = state.active;
    const noteOnly = mode === 'system' || req.reply_expected === false;
    if (!fork && !noteOnly && running && mode !== 'steer' && mode !== 'follow_up') {
      throw new RicHttpError(409, 'SESSION_BUSY', 'A turn is running in this session', true);
    }

    const turn: TurnState = {
      turnId,
      status: 'queued',
      log: new TurnEventLog(state.meta.session_id, turnId, this.clock),
    };
    state.turns.set(turnId, turn);
    this.deps.logger.info({ sessionId, turnId, mode }, 'turn accepted');

    if (fork) {
      // Runs beside a live turn: its own harness session on a copy of the history.
      void this.runFork(state, turn, req, validToolToken(forkToken) ? forkToken : state.token);
    } else if (noteOnly) {
      // App notices and ambient messages: a note for the next prompt, never part of a live reply.
      this.note(state, turn, req.input.text);
    } else if (running && mode === 'follow_up') {
      // Queued after the running turn (and any queued before it); it then runs as its own prompt,
      // so its reply streams on its own turn.
      state.queue.push({ turn, req });
    } else if (running) {
      // steer: the text joins the running turn through Pi's steering; its output streams there.
      // (Before the harness is up, it waits as a note for the next prompt.)
      if (state.handle) this.inject(state, turn, req);
      else this.note(state, turn, req.input.text);
    } else {
      this.start(state, turn, req);
    }
    return { status: 202, turn: this.turnView(state, turn) };
  }

  getTurn(sessionId: string, turnId: string): Turn {
    const state = this.require(sessionId);
    const turn = state.turns.get(turnId.toLowerCase());
    if (!turn) throw notFound('Turn');
    return this.turnView(state, turn);
  }

  /** The turn's event log (SSE). */
  events(sessionId: string, turnId: string): TurnEventLog {
    const state = this.require(sessionId);
    const turn = state.turns.get(turnId.toLowerCase());
    if (!turn) throw notFound('Turn');
    return turn.log;
  }

  cancelTurn(sessionId: string, turnId: string): void {
    const state = this.require(sessionId);
    const turn = state.turns.get(turnId.toLowerCase());
    if (!turn) throw notFound('Turn');
    if (state.active === turn) this.cancelState(state, turn);
    const queued = state.queue.findIndex((q) => q.turn === turn);
    if (queued !== -1) {
      state.queue.splice(queued, 1);
      this.emitter(state, turn)('turn.cancelled', {});
    }
  }

  /** Disposes every harness session (shutdown). */
  close(): void {
    for (const state of this.sessions.values()) {
      for (const { turn } of state.queue.splice(0)) this.emitter(state, turn)('turn.cancelled', {});
      if (state.active) this.cancelState(state, state.active);
      this.dropHandle(state);
    }
  }

  // ------------------------------------------------------------------ internals

  private assertTokenFor(sessionKey: string, token: ToolToken): void {
    if (tokenSessionKey(token) !== sessionKey) {
      throw new RicHttpError(422, 'SCOPE_MISMATCH', 'The tool token belongs to another session');
    }
  }

  private track(meta: SessionMeta, token: ToolToken | undefined): SessionState {
    const state: SessionState = {
      meta,
      token,
      turns: new Map(),
      active: null,
      queue: [],
      approvals: new Map(),
    };
    this.sessions.set(meta.session_id, state);
    return state;
  }

  /** In memory, or reloaded lazily from disk after a restart (without a token until rotated). */
  private load(sessionId: string): SessionState | null {
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;
    const meta = this.deps.store.load(sessionId);
    return meta ? this.track(meta, undefined) : null;
  }

  private require(sessionId: string): SessionState {
    const state = this.load(sessionId);
    if (!state) throw notFound('Session');
    return state;
  }

  private requireOpen(sessionId: string): SessionState {
    const state = this.require(sessionId);
    if (state.meta.archived_at) throw notFound('Session');
    return state;
  }

  private view(state: SessionState): Session {
    const usage = state.handle?.contextUsage();
    return {
      session_id: state.meta.session_id,
      session_key: state.meta.session_key,
      kind: state.meta.kind,
      status: state.meta.archived_at ? 'archived' : state.active ? 'busy' : 'ready',
      bound_project_id: state.meta.bound_project_id,
      created_at: state.meta.created_at,
      ...({
        context: {
          ...(usage?.tokens != null && { tokens_used: usage.tokens }),
          ...(usage?.limit != null && { tokens_limit: usage.limit }),
          last_compacted_at: state.meta.last_compacted_at,
        },
      } as object),
    };
  }

  private turnView(state: SessionState, turn: TurnState): Turn {
    return {
      turn_id: turn.turnId,
      status: turn.status,
      ...(turn.failure && { failure: turn.failure }),
      ...(turn.usage && { usage: turn.usage }),
      events_url: `/v1/sessions/${state.meta.session_id}/turns/${turn.turnId}/events`,
    };
  }

  /** Forgets finished turns whose event log has outlived the TTL. */
  private sweep(state: SessionState): void {
    for (const [id, turn] of state.turns) {
      if (turn.log.expired(this.eventTtlMs)) state.turns.delete(id);
    }
  }

  private dropHandle(state: SessionState): void {
    state.handle?.dispose();
    void state.toolSet?.close().catch(() => undefined);
    state.handle = undefined;
    state.toolSet = undefined;
  }

  /** Records the terminal state from the turn's terminal event. */
  private emitter(state: SessionState, turn: TurnState) {
    return (type: Parameters<TurnEventLog['append']>[0], data?: Record<string, unknown>) => {
      const event = turn.log.append(type, data);
      if (!event) return;
      if (type === 'turn.completed') {
        turn.status = 'completed';
        turn.usage = data?.['usage'] as Turn['usage'];
      } else if (type === 'turn.failed') {
        turn.status = 'failed';
        turn.failure = data?.['error'] as RicError;
      } else if (type === 'turn.cancelled') {
        turn.status = 'cancelled';
      }
      if (turn.log.finished && state.active === turn) state.active = null;
    };
  }

  private note(state: SessionState, turn: TurnState, text: string): void {
    const emit = this.emitter(state, turn);
    emit('turn.started');
    if (text.trim()) {
      state.meta.pending_notes = [...state.meta.pending_notes, text.slice(0, 2000)].slice(-20);
      this.deps.store.save(state.meta);
    }
    emit('turn.completed', { usage: { steps: 0, model: this.deps.engine.model } });
  }

  private inject(state: SessionState, turn: TurnState, req: CreateTurnRequest): void {
    const emit = this.emitter(state, turn);
    emit('turn.started');
    const handle = state.handle;
    if (!handle) return;
    // A command ("/spec ...") is expanded by Pi; plain text joins as the person's message.
    const plan = planTurn(req, this.profileOf(state));
    handle.steer(plan.text, { expand: plan.expand }).then(
      () => {
        emit('step', { title: 'Added to the running reply' });
        emit('turn.completed', { usage: { steps: 0, model: this.deps.engine.model } });
      },
      () =>
        emit('turn.failed', {
          error: {
            code: 'INTERNAL',
            message: 'Could not add to the running reply',
            retryable: true,
          },
        }),
    );
  }

  private cancelState(state: SessionState, turn: TurnState): void {
    void state.handle?.abort().catch(() => undefined);
    if (turn.mapper) turn.mapper.cancel();
    else this.emitter(state, turn)('turn.cancelled', {});
    this.deps.logger.info(
      { sessionId: state.meta.session_id, turnId: turn.turnId },
      'turn cancelled',
    );
  }

  private profileOf(state: SessionState): ProfileName {
    return isProfile(state.meta.profile) ? state.meta.profile : 'central_arena';
  }

  /** question.asked on the running turn (ask_user through the extension's UI bridge). */
  private asked(state: SessionState, question: AskedQuestion): void {
    const active = state.active;
    if (active) this.emitter(state, active)('question.asked', { ...question });
  }

  private async ensureHandle(state: SessionState, turn: TurnState): Promise<AgentHandle> {
    if (state.handle && !(state.degradedTools && state.token)) return state.handle;
    this.dropHandle(state);
    let toolSet: ToolSet | undefined;
    if (state.token) {
      try {
        toolSet = await this.deps.tools.tools({
          token: () => state.token,
          turnId: () => state.active?.turnId ?? null,
          onArtifact: (proposal: ArtifactProposal) => {
            const active = state.active;
            if (active) this.emitter(state, active)('artifact.proposed', { ...proposal });
          },
          onQuestion: (question: QuestionProposal) => {
            const active = state.active;
            if (active) this.emitter(state, active)('question.asked', { ...question });
          },
        });
      } catch {
        this.deps.logger.warn(
          { sessionId: state.meta.session_id },
          'app tools unreachable: no tools this turn',
        );
      }
    }
    state.degradedTools = !toolSet;
    const paths = this.deps.store.paths(state.meta.session_id);
    const handle = await this.deps.engine.create({
      sessionDir: paths.piDir,
      cwd: paths.cwd,
      agentDir: paths.agentDir,
      session: sessionContext(state.meta),
      turnContext: () => state.turnContext,
      onQuestion: (question) => this.asked(state, question),
      tools: visibleTools(toolSet),
    });
    state.handle = handle;
    state.toolSet = toolSet;
    this.deps.logger.info(
      { sessionId: state.meta.session_id, turnId: turn.turnId, tools: toolSet?.tools.length ?? 0 },
      'harness session ready',
    );
    return handle;
  }

  /** Makes `turn` the active one and runs it; when it ends, the next queued follow_up starts. */
  private start(state: SessionState, turn: TurnState, req: CreateTurnRequest): void {
    state.active = turn;
    void this.run(state, turn, req).finally(() => {
      // Every exit (including early failures) frees the session.
      if (state.active === turn) state.active = null;
      if (state.active) return;
      const next = state.queue.shift();
      if (next) this.start(state, next.turn, next.req);
    });
  }

  private async run(state: SessionState, turn: TurnState, req: CreateTurnRequest): Promise<void> {
    const emit = this.emitter(state, turn);
    const sessionId = state.meta.session_id;
    const started = this.clock();
    turn.status = 'running';
    emit('turn.started');

    const reason = this.deps.engine.unavailableReason();
    if (reason) {
      emit('turn.failed', {
        error: { code: 'RUNTIME_UNAVAILABLE', message: reason, retryable: false },
      });
      this.deps.logger.warn({ sessionId, turnId: turn.turnId }, 'turn failed: runtime unavailable');
      return;
    }

    let handle: AgentHandle;
    try {
      handle = await this.ensureHandle(state, turn);
    } catch {
      emit('turn.failed', {
        error: { code: 'RUNTIME_UNAVAILABLE', message: 'The AI could not start', retryable: true },
      });
      return;
    }
    if (turn.log.finished) return; // cancelled while starting

    const mapper = new TurnMapper(emit, state.toolSet?.names ?? new Map(), this.deps.engine.model);
    turn.mapper = mapper;
    const unsubscribe = handle.subscribe((event) => mapper.handle(event));
    const timeoutS = Math.min(Math.max(1, req.limits?.timeout_s ?? DEFAULT_TURN_TIMEOUT_S), 1800);
    const timer = setTimeout(() => {
      void handle.abort().catch(() => undefined);
      mapper.fail({ code: 'INTERNAL', message: 'The AI took too long to answer', retryable: true });
    }, timeoutS * 1000);

    const notes = state.meta.pending_notes;
    const plan = planTurn(req, this.profileOf(state), notes);
    state.turnContext = plan.context;
    try {
      await handle.prompt(plan.text, { expand: plan.expand });
      if (notes.length) {
        // Only the notes this prompt carried: notices that came in while it ran wait for the next.
        state.meta.pending_notes = state.meta.pending_notes.filter((n) => !notes.includes(n));
        this.deps.store.save(state.meta);
      }
      mapper.finish();
    } catch {
      mapper.fail({
        code: 'RUNTIME_UNAVAILABLE',
        message: 'The AI could not answer',
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
      unsubscribe();
      if (state.active === turn) state.active = null;
      if (state.turnContext === plan.context) state.turnContext = undefined;
      this.deps.logger.info(
        {
          sessionId,
          turnId: turn.turnId,
          status: turn.status,
          events: turn.log.size,
          ms: this.clock() - started,
        },
        'turn finished',
      );
    }
  }

  /**
   * An ephemeral fork: a harness session of its own on an in-memory copy of this session's history,
   * with the fork's own tool token (same session_key, read-only scopes from the app). Its reply is
   * this turn's message.completed; drafts and questions it makes are dropped; nothing is written to
   * the session (Pi session file, notes or token).
   */
  private async runFork(
    state: SessionState,
    turn: TurnState,
    req: CreateTurnRequest,
    token: ToolToken | undefined,
  ): Promise<void> {
    const emit = this.emitter(state, turn);
    const sessionId = state.meta.session_id;
    const started = this.clock();
    turn.status = 'running';
    emit('turn.started');
    const reason = this.deps.engine.unavailableReason();
    if (reason) {
      emit('turn.failed', {
        error: { code: 'RUNTIME_UNAVAILABLE', message: reason, retryable: false },
      });
      return;
    }
    let toolSet: ToolSet | undefined;
    let handle: AgentHandle | undefined;
    try {
      if (token) {
        try {
          toolSet = await this.deps.tools.tools({
            token: () => token,
            turnId: () => turn.turnId,
            onArtifact: () => undefined,
            onQuestion: () => undefined,
          });
        } catch {
          this.deps.logger.warn({ sessionId }, 'app tools unreachable: fork runs without tools');
        }
      }
      const paths = this.deps.store.paths(sessionId);
      const plan = planTurn(req, this.profileOf(state));
      handle = await this.deps.engine.create({
        sessionDir: paths.piDir,
        cwd: paths.cwd,
        agentDir: paths.agentDir,
        session: sessionContext(state.meta),
        turnContext: () => plan.context,
        onQuestion: () => undefined,
        tools: visibleTools(toolSet),
        ephemeral: true,
      });
      const mapper = new TurnMapper(emit, toolSet?.names ?? new Map(), this.deps.engine.model);
      turn.mapper = mapper;
      const live = handle;
      const unsubscribe = live.subscribe((event) => mapper.handle(event));
      const timeoutS = Math.min(Math.max(1, req.limits?.timeout_s ?? DEFAULT_TURN_TIMEOUT_S), 1800);
      const timer = setTimeout(() => {
        void live.abort().catch(() => undefined);
        mapper.fail({
          code: 'INTERNAL',
          message: 'The AI took too long to answer',
          retryable: true,
        });
      }, timeoutS * 1000);
      try {
        await live.prompt(plan.text, { expand: plan.expand });
        mapper.finish();
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
    } catch {
      if (!turn.log.finished) {
        emit('turn.failed', {
          error: {
            code: 'RUNTIME_UNAVAILABLE',
            message: 'The AI could not answer',
            retryable: true,
          },
        });
      }
    } finally {
      handle?.dispose();
      void toolSet?.close().catch(() => undefined);
      this.deps.logger.info(
        { sessionId, turnId: turn.turnId, status: turn.status, ms: this.clock() - started },
        'fork turn finished',
      );
    }
  }
}
