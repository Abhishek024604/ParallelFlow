import { type AgentTool, ToolCallError } from './agent.js';

// Vercel deploy tools for the arena's AI: read-only calls to Vercel's public REST API with one
// server-wide key (VERCEL_TOKEN, optional VERCEL_TEAM_ID). Not MCP: Vercel's hosted MCP server takes
// only OAuth from clients Vercel has approved (SLICE_DEBT.md). Results are trimmed plain data; the
// key is sent only as the Authorization header and never appears in a result, error or log.

export interface VercelConfig {
  token: string;
  teamId?: string;
}

const API = 'https://api.vercel.com';
const MAX_RESULT = 12_000;
const LOG_LINES = 60;
const LOG_LINE = 300;
const TIMEOUT_MS = 20_000;
/** A deployment id (dpl_…) or its hostname (my-app-abc123.vercel.app). */
const DEPLOYMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

type Fetch = typeof fetch;
type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const iso = (v: unknown): string | undefined =>
  typeof v === 'number' ? new Date(v).toISOString() : undefined;
const clip = (s: string | undefined, n: number): string | undefined =>
  s === undefined ? undefined : s.length > n ? `${s.slice(0, n)}…` : s;

function result(value: unknown): string {
  const text = JSON.stringify(value, null, 1);
  return text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n…(trimmed)` : text;
}

/** `https://x.vercel.app/` → `x.vercel.app`; anything else unsafe → INVALID_ARGS. */
function deploymentRef(args: Record<string, unknown>): string {
  const raw = (str(args['deployment']) ?? '')
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!DEPLOYMENT.test(raw)) {
    throw new ToolCallError('INVALID_ARGS', 'deployment must be a deployment id or its URL');
  }
  return raw;
}

function summary(d: Json): Json {
  const meta = (d['meta'] ?? {}) as Json;
  return {
    id: d['uid'] ?? d['id'],
    project: d['name'],
    url: d['url'],
    state: d['readyState'] ?? d['state'],
    target: d['target'] ?? 'preview',
    created: iso(d['createdAt'] ?? d['created']),
    branch: str(meta['githubCommitRef']),
    commit: clip(str(meta['githubCommitMessage']), 120),
  };
}

/** The arena AI's Vercel tools, or none without a key. */
export function vercelTools(
  config: VercelConfig | undefined,
  fetchImpl: Fetch = fetch,
): AgentTool[] {
  if (!config?.token) return [];

  async function get(path: string, query: Record<string, string>, signal?: AbortSignal) {
    const url = new URL(path, API);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (config?.teamId) url.searchParams.set('teamId', config.teamId);
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${config?.token}`, Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch {
      throw new ToolCallError('UNAVAILABLE', 'Vercel did not answer. Try again later.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new ToolCallError('FORBIDDEN', "Vercel refused ParallelFlow's key for this.");
    }
    if (res.status === 404) throw new ToolCallError('NOT_FOUND', 'Vercel has no such deployment.');
    if (!res.ok) throw new ToolCallError('UNAVAILABLE', `Vercel answered ${res.status}.`);
    return res.text();
  }

  return [
    {
      name: 'vercel_list_deployments',
      description:
        "Recent Vercel deployments (newest first): project, URL, state (READY, ERROR, BUILDING…), production or preview, branch and commit. Optionally one project's, by project name or id.",
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'Vercel project name or id (prj_…)' },
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Default 10' },
        },
        additionalProperties: false,
      },
      async execute(args, signal) {
        const limit = Math.min(20, Math.max(1, Number(args['limit']) || 10));
        const query: Record<string, string> = { limit: String(limit) };
        const project = str(args['project'])?.trim();
        if (project) query[project.startsWith('prj_') ? 'projectId' : 'app'] = project;
        const body = JSON.parse(await get('/v6/deployments', query, signal)) as Json;
        const list = Array.isArray(body['deployments']) ? (body['deployments'] as Json[]) : [];
        return result({ deployments: list.map(summary) });
      },
    },
    {
      name: 'vercel_get_deployment',
      description:
        "One Vercel deployment's status: state, production or preview, when it was built, its git branch and commit, aliases, and the error Vercel reports if it failed.",
      parameters: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'Deployment id (dpl_…) or URL' } },
        required: ['deployment'],
        additionalProperties: false,
      },
      async execute(args, signal) {
        const ref = deploymentRef(args);
        const d = JSON.parse(
          await get(`/v13/deployments/${encodeURIComponent(ref)}`, {}, signal),
        ) as Json;
        const git = (d['gitSource'] ?? {}) as Json;
        return result({
          ...summary(d),
          ready: iso(d['ready']),
          sha: str(git['sha']),
          aliases: Array.isArray(d['alias']) ? (d['alias'] as unknown[]).slice(0, 5) : [],
          error: d['errorCode']
            ? { code: d['errorCode'], message: clip(str(d['errorMessage']), 500) }
            : undefined,
        });
      },
    },
    {
      name: 'vercel_build_errors',
      description:
        "The errors and warnings in a Vercel deployment's build log (the last lines only), to explain why a build failed.",
      parameters: {
        type: 'object',
        properties: { deployment: { type: 'string', description: 'Deployment id (dpl_…) or URL' } },
        required: ['deployment'],
        additionalProperties: false,
      },
      async execute(args, signal) {
        const ref = deploymentRef(args);
        const text = await get(
          `/v3/deployments/${encodeURIComponent(ref)}/events`,
          { builds: '1', limit: '1000' },
          signal,
        );
        return result({ lines: buildErrorLines(text) });
      },
    },
  ];
}

/** The error/warning lines of a build log (a JSON array or NDJSON of events), last ones, trimmed. */
export function buildErrorLines(body: string): string[] {
  let events: Json[];
  try {
    const parsed = JSON.parse(body) as unknown;
    events = Array.isArray(parsed) ? (parsed as Json[]) : [];
  } catch {
    events = body
      .split('\n')
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Json];
        } catch {
          return [];
        }
      });
  }
  const lines = events.flatMap((e) => {
    const payload = (e['payload'] ?? {}) as Json;
    const text = str(payload['text']) ?? str(e['text']) ?? '';
    const type = str(e['type']) ?? '';
    const bad = type === 'stderr' || /\b(error|failed|fatal|warn(ing)?)\b/i.test(text);
    return bad && text.trim() ? [clip(text.trim(), LOG_LINE) ?? ''] : [];
  });
  return lines.slice(-LOG_LINES);
}
