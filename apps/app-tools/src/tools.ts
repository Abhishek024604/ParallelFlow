import { createHash } from 'node:crypto';
import {
  FILE_NAME_RULE,
  hasUnsafeNameChars,
  isStandardFileName,
  parseQuestion,
} from '@parallelflow/contracts';
import type { Logger } from '@parallelflow/observability';
import { type ToolSpec, validateArgs } from './contract.js';
import {
  type Autonomy,
  decideAutonomy,
  type DenyCode,
  DRAFT_TOOLS,
  NOT_AVAILABLE_YET,
  toolPermitted,
} from './policy.js';
import type { ToolPrincipal } from './token.js';

// One App Tools call: permission → arguments → membership → autonomy → handler → audit row.
// Logs and audit rows carry the tool name, outcome, deny code and latency only: never arguments,
// results or tokens (CLAUDE.md rule 7). The audit row stores a SHA-256 of the arguments.

export type Args = Record<string, unknown>;

export type Outcome = 'ok' | 'denied' | 'error' | 'approval_required';

export interface CallAudit {
  tool: string;
  argsHash: string;
  outcome: Outcome;
  denyCode: string | null;
  latencyMs: number;
  /** The runtime turn the call belongs to, only when it was verified to be this session's. */
  turnId: string | null;
}

/** Data access for the tools. DbToolBackend in the app; a fake in unit tests. */
export interface ToolBackend {
  /** agent_policies level of a class for the token's project, or null if no row. */
  autonomy(p: ToolPrincipal, cls: string): Promise<Autonomy | null>;
  /** Is the personal agent's user a member of the bound project? */
  isProjectMember(p: ToolPrincipal): Promise<boolean>;
  /** Does this turn belong to the token's session? */
  turnBelongsToSession(p: ToolPrincipal, turnId: string): Promise<boolean>;
  readHistory(p: ToolPrincipal, args: { before?: string; limit?: number }): Promise<unknown>;
  projectOverview(p: ToolPrincipal): Promise<unknown>;
  listMembers(p: ToolPrincipal): Promise<unknown>;
  cycleState(p: ToolPrincipal): Promise<unknown>;
  listArtifacts(p: ToolPrincipal, args: { cycle_number?: number; kind?: string }): Promise<unknown>;
  /** null when the artifact is not one of the token's project (→ SCOPE_MISMATCH). */
  readArtifact(
    p: ToolPrincipal,
    args: { artifact_id: string; version_no?: number },
  ): Promise<unknown | null | 'NO_VERSION'>;
  search(p: ToolPrincipal, args: { query: string; limit?: number }): Promise<unknown>;
  /** memory.recall: the token's arena's memory graph (ADR-045), by words or key. */
  recall(
    p: ToolPrincipal,
    args: { query: string; type?: string; limit?: number },
  ): Promise<unknown>;
  /** Uploaded files of the token's arena, or of the private token's owner. */
  listFiles(p: ToolPrincipal, args: { limit?: number }): Promise<unknown>;
  /** null when the file is not the token's (→ SCOPE_MISMATCH). */
  readFile(p: ToolPrincipal, args: { file_id: string }): Promise<unknown | null>;
  /** The private token owner's artifacts. */
  listPrivateArtifacts(
    p: ToolPrincipal,
    args: { limit?: number; this_chat?: boolean },
  ): Promise<unknown>;
  /** null when not the owner's private artifact (→ SCOPE_MISMATCH). */
  readPrivateArtifact(
    p: ToolPrincipal,
    args: { artifact_id: string; version_no?: number },
  ): Promise<unknown | null | 'NO_VERSION'>;
  /**
   * stage.request_gate: the central agent asks the gate approvers (a gate request and its card,
   * like a person's). Votes stay human-only: there is no tool for them.
   */
  requestGate(
    p: ToolPrincipal,
    args: { summary: string; artifact_id?: string },
    turnId: string | null,
  ): Promise<Record<string, unknown>>;
  logCall(p: ToolPrincipal, audit: CallAudit): Promise<void>;
}

export interface CallResult {
  [key: string]: unknown;
  isError: boolean;
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
}

export class ToolDenied extends Error {
  constructor(
    readonly code: DenyCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolDenied';
  }
}

/** Invalid arguments: a protocol error (MCP InvalidParams), not a policy decision. */
export class InvalidToolArgs extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidToolArgs';
  }
}

/** Canonical JSON (sorted keys) → SHA-256 hex. */
export function argsHash(args: unknown): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Args)
              .sort()
              .map((k) => [k, canonical((v as Args)[k])]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(canonical(args ?? {})))
    .digest('hex');
}

const MAX_DRAFT_BYTES = 2 * 1024 * 1024;

function ok(data: Record<string, unknown>): CallResult {
  return {
    isError: false,
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function denied(code: DenyCode, message: string): CallResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message } },
  };
}

function draftAccepted(args: Args, home: 'arena' | 'private'): CallResult {
  const content = String(args['content'] ?? '');
  const name = String(args['name'] ?? '').trim();
  if (!name || name.length > 120) throw new InvalidToolArgs('args.name must be 1-120 characters');
  // The app would drop it silently (saveDraft): say so now, so the AI knows nothing was saved.
  if (hasUnsafeNameChars(name)) {
    throw new InvalidToolArgs('args.name must not contain slashes or control characters');
  }
  // ADR-038: arena files have standard names; Private is free-form.
  if (home === 'arena' && !isStandardFileName(name)) {
    throw new InvalidToolArgs(`args.name "${name}" is not allowed. ${FILE_NAME_RULE}`);
  }
  if (!content || Buffer.byteLength(content, 'utf8') > MAX_DRAFT_BYTES) {
    throw new InvalidToolArgs('args.content must be 1 byte to 2 MB');
  }
  // ADR-035: the runtime turns an accepted draft into the RIC artifact.proposed event and the app
  // stores it (one storage path for drafts: never approved, versioned by name).
  return ok({
    status: 'accepted',
    delivery: 'artifact.proposed',
    home,
    name,
    kind: String(args['kind'] ?? 'document'),
    note: 'Saved as a draft for the team to review. It is not approved.',
  });
}

async function handle(
  backend: ToolBackend,
  p: ToolPrincipal,
  name: string,
  args: Args,
  turnId: string | null,
): Promise<CallResult> {
  switch (name) {
    case 'arena.read_history':
      return ok({ messages: await backend.readHistory(p, args) });
    case 'project.get_overview':
      return ok({ project: await backend.projectOverview(p) });
    case 'members.list':
      return ok({ members: await backend.listMembers(p) });
    case 'cycle.get_state':
      return ok({ cycle: await backend.cycleState(p) });
    case 'artifacts.list':
      return ok({ artifacts: await backend.listArtifacts(p, args) });
    case 'artifacts.read': {
      const artifact = await backend.readArtifact(
        p,
        args as { artifact_id: string; version_no?: number },
      );
      if (artifact === null) {
        throw new ToolDenied('SCOPE_MISMATCH', 'That artifact is not in this arena');
      }
      if (artifact === 'NO_VERSION') throw new ToolDenied('NOT_FOUND', 'No such version');
      return ok({ artifact });
    }
    case 'files.list':
      return ok({ files: await backend.listFiles(p, args as { limit?: number }) });
    case 'files.read': {
      const file = await backend.readFile(p, args as { file_id: string });
      if (file === null) throw new ToolDenied('SCOPE_MISMATCH', 'That file is not here');
      return ok({ file });
    }
    case 'private.list_artifacts':
      return ok({
        artifacts: await backend.listPrivateArtifacts(
          p,
          args as { limit?: number; this_chat?: boolean },
        ),
      });
    case 'private.read_artifact': {
      const artifact = await backend.readPrivateArtifact(
        p,
        args as { artifact_id: string; version_no?: number },
      );
      if (artifact === null) {
        throw new ToolDenied('SCOPE_MISMATCH', 'That artifact is not in your Private space');
      }
      if (artifact === 'NO_VERSION') throw new ToolDenied('NOT_FOUND', 'No such version');
      return ok({ artifact });
    }
    case 'knowledge.search':
      return ok({ results: await backend.search(p, args as { query: string; limit?: number }) });
    case 'memory.recall':
      return ok({
        memory: await backend.recall(p, args as { query: string; type?: string; limit?: number }),
      });
    case 'artifacts.create_draft':
      return draftAccepted(args, 'arena');
    case 'private.save_artifact':
      return draftAccepted(args, 'private');
    case 'ask.question': {
      // The runtime turns an accepted question into the RIC question.asked event; the app shows it
      // as a card that only the person who asked the AI can answer.
      const ask = parseQuestion(args);
      if ('error' in ask) throw new InvalidToolArgs(`args: ${ask.error}`);
      return ok({
        status: 'accepted',
        delivery: 'question.asked',
        ...ask,
        note: 'The question is shown to them with these options. Stop now and wait for their answer; do not answer it yourself or continue the task.',
      });
    }
    case 'stage.request_gate':
      return ok(
        await backend.requestGate(p, args as { summary: string; artifact_id?: string }, turnId),
      );
    default:
      throw new ToolDenied('FORBIDDEN', 'not available yet');
  }
}

export interface ExecuteDeps {
  specs: ReadonlyMap<string, ToolSpec>;
  backend: ToolBackend;
  logger: Logger;
  clock?: () => number;
  /** Write the audit row without delaying the reply (main.ts). Tests await it. */
  auditInBackground?: boolean;
}

/** Runs one call. Never throws except InvalidToolArgs; denials come back as error results. */
export async function executeTool(
  deps: ExecuteDeps,
  p: ToolPrincipal,
  name: string,
  rawArgs: unknown,
  turnId: string | null,
): Promise<CallResult> {
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const args = (rawArgs ?? {}) as Args;
  let outcome: Outcome = 'ok';
  let denyCode: string | null = null;
  let result: CallResult | undefined;
  let invalid: InvalidToolArgs | undefined;

  try {
    const spec = deps.specs.get(name);
    if (!spec) throw new ToolDenied('NOT_FOUND', 'Unknown tool');
    if (!toolPermitted(spec, p)) {
      throw new ToolDenied('FORBIDDEN', 'This AI may not use that tool here');
    }
    if (NOT_AVAILABLE_YET.has(name)) throw new ToolDenied('FORBIDDEN', 'not available yet');
    const argError = validateArgs(spec.inputSchema, args);
    if (argError) throw new InvalidToolArgs(argError);

    // A personal agent bound to a project acts with its user's access: the user must be a member.
    if (p.kind === 'personal' && p.projectId && !(await deps.backend.isProjectMember(p))) {
      throw new ToolDenied('FORBIDDEN', 'You are not a member of that arena');
    }
    // Layer 2 of autonomy (doc 08): the project's agent policy. Private has no policy (owner's own).
    const cls = spec['x-parallelflow'].autonomy_class;
    if (cls && p.projectId) {
      const level = (await deps.backend.autonomy(p, cls)) ?? 'suggest';
      const decision = decideAutonomy(spec['x-parallelflow'].side_effect, level);
      if (decision.kind === 'deny') {
        throw new ToolDenied(
          decision.code,
          decision.code === 'FORBIDDEN'
            ? 'The arena has turned this off for the AI'
            : 'A teammate must approve this first',
        );
      }
      if (decision.kind === 'draft_only' && !DRAFT_TOOLS.has(name)) {
        throw new ToolDenied('FORBIDDEN', 'The AI may only suggest this; it cannot do it');
      }
    }
    result = await handle(deps.backend, p, name, args, turnId);
  } catch (err) {
    if (err instanceof ToolDenied) {
      outcome = err.code === 'APPROVAL_REQUIRED' ? 'approval_required' : 'denied';
      denyCode = err.code;
      result = denied(err.code, err.message);
    } else if (err instanceof InvalidToolArgs) {
      outcome = 'error';
      denyCode = 'INVALID_INPUT';
      invalid = err;
    } else {
      outcome = 'error';
      result = {
        isError: true,
        content: [{ type: 'text', text: 'ERROR: the tool failed' }],
        structuredContent: { error: { code: 'INTERNAL', message: 'The tool failed' } },
      };
    }
  }

  const latencyMs = Math.max(0, Math.round(clock() - started));
  // The audit row is written off the reply path (its two round trips no longer delay the AI). It is
  // still always attempted, and a failure is reported like before.
  const audit = async () => {
    const verifiedTurn =
      turnId && (await deps.backend.turnBelongsToSession(p, turnId).catch(() => false))
        ? turnId
        : null;
    try {
      await deps.backend.logCall(p, {
        tool: name.slice(0, 100),
        argsHash: argsHash(args),
        outcome,
        denyCode,
        latencyMs,
        turnId: verifiedTurn,
      });
    } catch {
      deps.logger.warn({ tool: name.slice(0, 100) }, 'app tools: could not write the audit row');
    }
  };
  const audited = audit();
  if (!deps.auditInBackground) await audited;
  deps.logger.info({ tool: name.slice(0, 100), outcome, denyCode, latencyMs }, 'app tool call');

  if (invalid || !result) throw invalid ?? new InvalidToolArgs('Invalid call');
  return result;
}
