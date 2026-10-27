import type {
  AskedQuestion,
  ParallelFlowSessionContext,
  ParallelFlowTurnContext,
} from '@parallelflow/pi-parallelflow';
import type { TurnExtensions } from '@parallelflow/runtime-client';

// The small seam between the RIC service and the Pi harness (ADR-035). The service only talks to an
// AgentEngine / AgentHandle; pi-engine.ts implements them with Pi (and the ParallelFlow Pi extension from
// @parallelflow/pi-parallelflow), and tests use a fake so no model is ever called in unit tests.

/** A JSON Schema object (App Tools input schemas are passed through unchanged). */
export type JsonSchema = Record<string, unknown>;

/** A tool the agent may call. Only App Tools: Pi's built-in tools are never enabled. */
export interface AgentTool {
  /** Model-facing name (provider-safe: letters, digits, _ and -). */
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Runs the tool. Throws ToolCallError for a denied or failed call (the model sees the message). */
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export class ToolCallError extends Error {
  constructor(
    /** A short machine code such as FORBIDDEN or SCOPE_MISMATCH. Safe to put in events. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolCallError';
  }
}

/**
 * An event from the harness. Pi's AgentSessionEvent, typed loosely: the mapper reads only the fields
 * it needs (mapping.ts), so a Pi minor version that adds fields changes nothing here.
 */
export interface HarnessEvent {
  type: string;
  [key: string]: unknown;
}

export interface CreateAgentOptions {
  /** This session's own folder: the Pi session file and nothing else live here. */
  sessionDir: string;
  /** An empty folder of this session, so Pi's resource discovery finds nothing (no AGENTS.md). */
  cwd: string;
  /** Pi's agent dir for this session (no global ~/.pi config is read). */
  agentDir: string;
  /** What the ParallelFlow extension knows about the session (profile, AI name, brief, team). */
  session: ParallelFlowSessionContext;
  /** The running turn's data, read by the extension when each agent run starts and on tool calls. */
  turnContext: () => ParallelFlowTurnContext | undefined;
  /** ask_user through Pi's ctx.ui.select: the service emits question.asked on the running turn. */
  onQuestion: (question: AskedQuestion) => void;
  tools: AgentTool[];
  /**
   * An ephemeral fork: the harness starts from a copy of this session's history (sessionDir's
   * newest Pi session file), kept in memory only. Nothing is written; the parent is untouched.
   */
  ephemeral?: boolean;
  /** Private extensions installed by the chat's owner, with their connections (ADR-039). */
  extensions?: TurnExtensions;
}

/** How a text enters the harness. */
export interface PromptOptions {
  /** Expand a leading /template or /skill:name (Pi prompt templates and skills). */
  expand?: boolean;
}

export interface ContextUsage {
  tokens: number | null;
  limit: number | null;
}

/** One live harness session. Never shared between RIC sessions. */
export interface AgentHandle {
  subscribe(listener: (event: HarnessEvent) => void): () => void;
  /** Runs one agent turn; resolves when the harness has finished it. */
  prompt(text: string, options?: PromptOptions): Promise<void>;
  /** Injects text into the running turn. */
  steer(text: string, options?: PromptOptions): Promise<void>;
  /** Queues text to run after the current turn. */
  followUp(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  compact(): Promise<void>;
  isStreaming(): boolean;
  contextUsage(): ContextUsage | undefined;
  dispose(): void;
}

export interface AgentEngine {
  /** null when turns can run; otherwise why not (no API key, Pi not installed). Safe to show. */
  unavailableReason(): string | null;
  /** The model id used for usage reports when a response names none. */
  readonly model: string;
  /** Every model id a session may route to (capabilities). */
  readonly models?: readonly string[];
  create(options: CreateAgentOptions): Promise<AgentHandle>;
}
