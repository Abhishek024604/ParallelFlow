// The small protocol between the saras-guard Pi extension and the VS Code side. The guard asks
// through Pi's extension UI (`ctx.ui.select` over RPC); the title carries one of these requests as
// JSON and the selected value carries the answer as JSON. Dependency-free: it runs inside Pi too.

export const UI_TAG = 'saras-ui/1';

export type GuardRequest =
  | { tag: typeof UI_TAG; kind: 'command'; command: string; cwd: string; reason: string }
  | { tag: typeof UI_TAG; kind: 'edit'; tool: string; path: string; reason: string }
  | { tag: typeof UI_TAG; kind: 'question'; question: string; options: string[] };

export type Decision = 'approve' | 'approve_session' | 'deny';

export type GuardAnswer = { decision: Decision; reason?: string } | { answer: string };

export const SELECT_OPTIONS = ['approve', 'approve_session', 'deny'];

type Distribute<T> = T extends unknown ? Omit<T, 'tag'> : never;

export function encodeRequest(request: Distribute<GuardRequest>): string {
  return JSON.stringify({ tag: UI_TAG, ...request });
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

export function decodeRequest(title: string): GuardRequest | undefined {
  if (!title.startsWith('{')) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(title);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (r.tag !== UI_TAG) return undefined;
  const str = (k: string) => typeof r[k] === 'string';
  if (r.kind === 'command' && str('command') && str('cwd') && str('reason'))
    return r as GuardRequest;
  if (r.kind === 'edit' && str('tool') && str('path') && str('reason')) return r as GuardRequest;
  if (r.kind === 'question' && str('question') && isStringArray(r.options))
    return r as GuardRequest;
  return undefined;
}

export function encodeAnswer(answer: GuardAnswer): string {
  return JSON.stringify(answer);
}

/** Parse the selected value. Anything unexpected (or nothing, on timeout) is a denial. */
export function decodeDecision(value: string | undefined): { decision: Decision; reason?: string } {
  if (value === undefined) return { decision: 'deny', reason: 'No answer in time' };
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    const d = v.decision;
    if (d === 'approve' || d === 'approve_session' || d === 'deny') {
      const reason = typeof v.reason === 'string' ? v.reason.slice(0, 1000) : undefined;
      return reason ? { decision: d, reason } : { decision: d };
    }
  } catch {
    // fall through
  }
  return { decision: 'deny', reason: 'Unrecognised answer' };
}

export function decodeQuestionAnswer(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return typeof v.answer === 'string' ? v.answer.slice(0, 4000) : undefined;
  } catch {
    return undefined;
  }
}

/** Configuration the VS Code side hands the guard through SARAS_GUARD_CONFIG. */
export interface GuardConfig {
  root: string;
  allowlist: string[];
  autoApproveEdits: boolean;
  approvalTimeoutMs: number;
  tmpDir: string;
  /** The Saras LLM proxy. Unset when the agent runs on the person's Claude subscription instead. */
  llm?: {
    baseUrl: string;
    models: {
      id: string;
      name: string;
      contextWindow: number;
      maxTokens: number;
      reasoning: boolean;
    }[];
  };
  /** Codebase-intelligence MCP server hosted by the VS Code extension (localhost, bearer token). */
  mcpUrl?: string;
}

export function parseGuardConfig(raw: string | undefined): GuardConfig | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as GuardConfig;
    if (
      typeof v.root !== 'string' ||
      !isStringArray(v.allowlist) ||
      typeof v.autoApproveEdits !== 'boolean' ||
      typeof v.approvalTimeoutMs !== 'number' ||
      typeof v.tmpDir !== 'string' ||
      (v.llm !== undefined && (typeof v.llm?.baseUrl !== 'string' || !Array.isArray(v.llm.models)))
    ) {
      return undefined;
    }
    return v;
  } catch {
    return undefined;
  }
}
