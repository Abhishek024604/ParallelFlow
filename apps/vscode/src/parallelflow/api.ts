import type { ModelTier } from '../shared/agent-config.js';
// ParallelFlow HTTP client for the extension. Every request and response type lives here with runtime
// validation (zod), so a server change shows up as a clear error instead of undefined behaviour.
// Bodies are never logged: they can contain task text, and requests carry the access token.
import { z } from 'zod';

// ---- Schemas -------------------------------------------------------------------------------------

export const DeviceCodeSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().nonnegative(),
});
export type DeviceCode = z.infer<typeof DeviceCodeSchema>;

export const UserSchema = z
  .object({ id: z.string().min(1), display_name: z.string(), email: z.string() })
  .passthrough();
export type ParallelFlowUser = z.infer<typeof UserSchema>;

export const DeviceTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z.number().positive(),
  user: UserSchema,
});
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;

export const DEVICE_ERRORS = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
] as const;
export const DeviceTokenErrorSchema = z.object({ error: z.enum(DEVICE_ERRORS) }).passthrough();
export type DeviceTokenError = z.infer<typeof DeviceTokenErrorSchema>['error'];

export type DeviceTokenResult =
  { ok: true; token: DeviceToken } | { ok: false; error: DeviceTokenError };

export const MeSchema = UserSchema;

export const ArenaSchema = z
  .object({
    /** The arena's project id; every /v1/ext/projects/:p route takes it. */
    id: z.string().min(1),
    name: z.string(),
    key: z.string().optional().default(''),
    cycle: z.number().nullable().optional().default(null),
    stage: z.string().nullable().optional().default(null),
    role: z.string().optional().default('member'),
  })
  .passthrough();
export type Arena = z.infer<typeof ArenaSchema>;
export const ArenaListSchema = z.object({ items: z.array(ArenaSchema) });

const LlmModelSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    context_window: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    reasoning: z.boolean().optional(),
    /** The runtime tier (fast / strong / fallback), for the parallelflow/auto router. */
    tier: z.enum(['fast', 'strong', 'fallback']).optional(),
  })
  .passthrough();
/** GET /v1/llm/models: OpenAI-style `{data: [...]}`, or `{items}` / `{models}`. */
export const LlmModelListSchema = z
  .union([
    z.object({ data: z.array(LlmModelSchema) }),
    z.object({ items: z.array(LlmModelSchema) }),
    z.object({ models: z.array(LlmModelSchema) }),
  ])
  .transform((v) => ('data' in v ? v.data : 'items' in v ? v.items : v.models));
export interface LlmModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  tier?: ModelTier;
}

export const CodingSessionSchema = z
  .object({
    id: z.string().min(1),
    branch: z.string().min(1),
    base_sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  })
  .passthrough();
export type CodingSession = z.infer<typeof CodingSessionSchema>;

export const StartTaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
});
export type StartTask = z.input<typeof StartTaskSchema>;

export const PROGRESS_KINDS = ['progress', 'tests', 'blocked', 'done'] as const;
export const ProgressEventSchema = z.object({
  kind: z.enum(PROGRESS_KINDS),
  summary: z.string().trim().min(1).max(500),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string().optional(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const OpenPullSchema = z.object({
  coding_session_id: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  description: z.string().max(10_000).default(''),
});

export const MAX_PUSH_BYTES = 50 * 1024 * 1024;

// ---- Errors --------------------------------------------------------------------------------------

export class ParallelFlowApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 401: the token is missing, expired or revoked. Sign in again. */
export class ParallelFlowAuthError extends ParallelFlowApiError {}

function errorFromBody(status: number, body: unknown): ParallelFlowApiError {
  let code = `HTTP_${status}`;
  let message = `ParallelFlow answered ${status}`;
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const nested =
      b.error && typeof b.error === 'object' ? (b.error as Record<string, unknown>) : b;
    if (typeof nested.code === 'string') code = nested.code;
    else if (typeof b.error === 'string') code = b.error;
    if (typeof nested.message === 'string') message = nested.message;
  }
  return status === 401
    ? new ParallelFlowAuthError(status, code, message)
    : new ParallelFlowApiError(status, code, message);
}

// ---- Client --------------------------------------------------------------------------------------

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ParallelFlowApiOptions {
  baseUrl: string;
  getToken(): Promise<string | undefined>;
  fetch?: FetchLike;
  onUnauthorized?(): void;
  timeoutMs?: number;
}

export class ParallelFlowApi {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly opts: ParallelFlowApiOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  /** Link to the arena's PR page in the web app. */
  pullUrl(projectId: string, number: number): string {
    return `${this.baseUrl}/arena/${encodeURIComponent(projectId)}?pr=${number}`;
  }

  private async raw(
    method: string,
    path: string,
    options: { json?: unknown; body?: Uint8Array; auth?: boolean; accept?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: options.accept ?? 'application/json' };
    if (options.auth !== false) {
      const token = await this.opts.getToken();
      if (!token) throw new ParallelFlowAuthError(401, 'NOT_SIGNED_IN', 'Sign in to ParallelFlow first');
      headers.Authorization = `Bearer ${token}`;
    }
    let body: BodyInit | undefined;
    if (options.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.body) {
      headers['Content-Type'] = 'application/octet-stream';
      body = options.body;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new ParallelFlowApiError(
        0,
        'NETWORK',
        `Could not reach ParallelFlow at ${this.baseUrl} (${(err as Error).message})`,
      );
    }
    if (res.status === 401 && options.auth !== false) this.opts.onUnauthorized?.();
    return res;
  }

  private async json<T>(
    method: string,
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    options: { json?: unknown; body?: Uint8Array; auth?: boolean } = {},
  ): Promise<T> {
    const res = await this.raw(method, path, options);
    const body = await readJson(res);
    if (!res.ok) throw errorFromBody(res.status, body);
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ParallelFlowApiError(
        res.status,
        'BAD_RESPONSE',
        `Unexpected response from ${method} ${path}`,
      );
    }
    return parsed.data;
  }

  deviceCode(clientName: string): Promise<DeviceCode> {
    return this.json('POST', '/v1/ext/device/code', DeviceCodeSchema, {
      json: { client_name: clientName },
      auth: false,
    });
  }

  async deviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await this.raw('POST', '/v1/ext/device/token', {
      json: { device_code: deviceCode },
      auth: false,
    });
    const body = await readJson(res);
    if (res.ok) {
      const token = DeviceTokenSchema.safeParse(body);
      if (!token.success)
        throw new ParallelFlowApiError(res.status, 'BAD_RESPONSE', 'Unexpected sign-in response');
      return { ok: true, token: token.data };
    }
    const err = DeviceTokenErrorSchema.safeParse(body);
    if (res.status === 400 && err.success) return { ok: false, error: err.data.error };
    throw errorFromBody(res.status, body);
  }

  me(): Promise<ParallelFlowUser> {
    return this.json('GET', '/v1/me', MeSchema);
  }

  async arenas(): Promise<Arena[]> {
    return (await this.json('GET', '/v1/arenas', ArenaListSchema)).items;
  }

  async llmModels(): Promise<LlmModel[]> {
    const models = await this.json('GET', '/v1/llm/models', LlmModelListSchema);
    return models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      contextWindow: m.context_window ?? 128_000,
      maxTokens: m.max_tokens ?? 16_384,
      reasoning: m.reasoning ?? false,
      ...(m.tier && { tier: m.tier }),
    }));
  }

  /** The arena repo as a git bundle. */
  async repoBundle(projectId: string): Promise<Uint8Array> {
    const res = await this.raw('GET', `/v1/ext/projects/${enc(projectId)}/repo/bundle`, {
      accept: 'application/octet-stream',
    });
    if (!res.ok) throw errorFromBody(res.status, await readJson(res));
    return new Uint8Array(await res.arrayBuffer());
  }

  startCodingSession(projectId: string, task: StartTask): Promise<CodingSession> {
    return this.json(
      'POST',
      `/v1/ext/projects/${enc(projectId)}/coding-sessions`,
      CodingSessionSchema,
      {
        json: StartTaskSchema.parse(task),
      },
    );
  }

  async postEvent(projectId: string, sessionId: string, event: ProgressEvent): Promise<void> {
    const body = ProgressEventSchema.parse({ ...event, summary: event.summary.slice(0, 500) });
    const res = await this.raw(
      'POST',
      `/v1/ext/projects/${enc(projectId)}/coding-sessions/${enc(sessionId)}/events`,
      {
        json: body,
      },
    );
    if (!res.ok) throw errorFromBody(res.status, await readJson(res));
  }

  async push(projectId: string, sessionId: string, bundle: Uint8Array): Promise<void> {
    if (bundle.byteLength > MAX_PUSH_BYTES) {
      throw new ParallelFlowApiError(413, 'TOO_LARGE', 'The branch bundle is over 50 MB');
    }
    const res = await this.raw(
      'POST',
      `/v1/ext/projects/${enc(projectId)}/coding-sessions/${enc(sessionId)}/push`,
      {
        body: bundle,
      },
    );
    if (!res.ok) throw errorFromBody(res.status, await readJson(res));
  }

  openPull(
    projectId: string,
    input: { coding_session_id: string; title: string; description?: string },
  ): Promise<PullRequest> {
    return this.json('POST', `/v1/ext/projects/${enc(projectId)}/pulls`, PullRequestSchema, {
      json: OpenPullSchema.parse(input),
    });
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
