// Types of the Runtime Integration Contract v0.2 (docs/contracts/runtime-integration-contract_v0.2.yaml).
// Only the parts the app uses today; field names match the contract exactly.

export type Autonomy = 'off' | 'suggest' | 'approve' | 'act';

export const AUTONOMY_CLASSES = [
  'answer',
  'post',
  'draft_artifacts',
  'tasks',
  'request_gate',
  'assigned_work',
  'notify',
] as const;
export type AutonomyClass = (typeof AUTONOMY_CLASSES)[number];
export type AutonomyPolicy = Partial<Record<AutonomyClass, Autonomy>>;

export type SdlcStage = 'PLAN' | 'DESIGN' | 'BUILD' | 'TEST' | 'DEPLOY' | 'MAINTAIN';

export type RuntimeErrorCode =
  | 'UNAUTHENTICATED'
  | 'NOT_FOUND'
  | 'SESSION_KEY_CONFLICT'
  | 'SCOPE_MISMATCH'
  | 'ALREADY_BOUND'
  | 'SESSION_BUSY'
  | 'RATE_LIMITED'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_INPUT'
  | 'PROFILE_UNKNOWN'
  | 'RUNTIME_UNAVAILABLE'
  | 'INTERNAL';

/** Error body of the contract. */
export interface RicError {
  code: RuntimeErrorCode;
  message: string;
  retryable?: boolean;
  retry_after_ms?: number;
}

export interface ToolToken {
  token: string;
  expires_at: string;
  mcp_url: string;
}

export interface Scope {
  org_id: string;
  project_id?: string | null;
  user_id?: string | null;
}

export interface CreateSessionRequest {
  session_key: string;
  kind: 'arena' | 'private';
  scope: Scope;
  profile: string;
  agent: {
    id: string;
    kind: 'central' | 'personal';
    display_name: string;
    on_behalf_of?: string | null;
  };
  context_seed?: {
    org_brief?: string;
    project_brief?: string;
    members?: { user_id: string; display_name: string; roles: string[] }[];
  };
  tool_token: ToolToken;
  retention_days?: number;
}

export interface Session {
  session_id: string;
  session_key: string;
  status: 'provisioning' | 'ready' | 'busy' | 'degraded' | 'archived' | 'failed';
  kind?: 'arena' | 'private';
  bound_project_id?: string | null;
  created_at?: string;
}

export type TurnMode = 'prompt' | 'steer' | 'follow_up' | 'system' | 'routine' | 'assignment';

export interface CreateTurnRequest {
  turn_id: string;
  mode?: TurnMode;
  input: {
    author: { type: 'user' | 'system'; id: string; display_name: string; roles?: string[] };
    text: string;
    message_id?: string;
    mentions?: { type: 'user' | 'agent'; id: string }[];
    /** Artifacts the turn may refer to (RIC v0.2 CreateTurn input.attachments). */
    attachments?: { artifact_id: string; version_no: number; name: string }[];
  };
  autonomy?: AutonomyPolicy;
  reply_expected?: boolean;
  app_state?: { cycle_number?: number; stage?: SdlcStage };
  limits?: { max_steps?: number; max_cost_usd?: number; timeout_s?: number };
  /** RIC v0.2.1: run one of the profile's skills (Capabilities profiles[].skills) on input.text. */
  skill?: string;
  /**
   * RIC v0.2.1 (mode prompt only): run on an in-memory copy of the session's history; nothing is
   * written to the session, and it may run while another turn is running.
   */
  ephemeral_fork?: boolean;
  /** RIC v0.2.1 (ephemeral_fork only): the fork's own App Tools token for the same session_key. */
  tool_token?: ToolToken;
  /**
   * ParallelFlow additive (ADR-039, private turns only): the person's installed extensions and the
   * credentials of their connected services. Secrets: never logged or stored by the runtime.
   */
  extensions?: TurnExtensions;
}

export interface TurnExtensions {
  /** Extension keys ("swa", "pm"). */
  installed: string[];
  /** Linear (remote MCP) for the PM extension: the person's API key. */
  linear?: { token: string };
}

export interface Usage {
  input_tokens?: number;
  cached_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
  steps?: number;
  model?: string;
}

export type TurnStatus =
  'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';

export interface Turn {
  turn_id: string;
  status: TurnStatus;
  failure?: RicError;
  usage?: Usage;
  events_url?: string;
}

export type RuntimeEventType =
  | 'turn.started'
  | 'message.delta'
  | 'message.completed'
  | 'step'
  | 'tool.called'
  | 'tool.result'
  | 'approval.requested'
  | 'artifact.proposed'
  | 'question.asked'
  | 'context.compacted'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.cancelled';

/** One SSE frame's data. `data` depends on `type`; read it with the helpers below. */
export interface RuntimeEvent {
  seq: number;
  type: RuntimeEventType;
  turn_id: string;
  session_id: string;
  at: string;
  data?: Record<string, unknown>;
}

export const TERMINAL_EVENTS: ReadonlySet<RuntimeEventType> = new Set([
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
]);

/** `data.text` of message.delta / message.completed, or ''. */
export function eventText(event: RuntimeEvent): string {
  const text = event.data?.['text'];
  return typeof text === 'string' ? text : '';
}

/** `data.usage` of turn.completed. */
export function eventUsage(event: RuntimeEvent): Usage {
  const usage = event.data?.['usage'];
  return usage && typeof usage === 'object' ? (usage as Usage) : {};
}

/** RIC ArtifactProposed: the runtime produced a document; the app stores it as a draft. */
export interface ArtifactProposal {
  name: string;
  kind: string;
  content: string;
  content_type: string;
}

/** `data` of artifact.proposed, when it has the required fields. */
export function eventArtifact(event: RuntimeEvent): ArtifactProposal | undefined {
  const data = event.data;
  if (!data) return undefined;
  const { name, kind, content, content_type: type } = data;
  if (typeof name !== 'string' || typeof kind !== 'string' || typeof content !== 'string') {
    return undefined;
  }
  return { name, kind, content, content_type: typeof type === 'string' ? type : 'text/markdown' };
}

/** `data` of question.asked: the AI's multiple-choice question (ask.question). */
export interface QuestionAsked {
  question: string;
  options: string[];
  allow_other: boolean;
}

/** `data` of question.asked, when it has the required fields. */
export function eventQuestion(event: RuntimeEvent): QuestionAsked | undefined {
  const data = event.data;
  if (!data) return undefined;
  const { question, options, allow_other: other } = data;
  if (typeof question !== 'string' || !Array.isArray(options)) return undefined;
  if (!options.every((o): o is string => typeof o === 'string')) return undefined;
  return { question, options, allow_other: other === true };
}

/** `data.error.code` of turn.failed. */
export function eventErrorCode(event: RuntimeEvent): string | undefined {
  const error = event.data?.['error'];
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
