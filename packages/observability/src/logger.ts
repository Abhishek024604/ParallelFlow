import { pino, type DestinationStream, type Logger } from 'pino';

// Structured logs (doc 11 §11.2). Ids and metadata only: never message or artifact content, prompts,
// request bodies, cookies, Authorization headers, tokens or Idempotency-Key values (CLAUDE.md rule 7).
//
// Callers log an explicit allowlist of fields (see AccessLogEntry). Redaction is the second line of
// defence for anything that slips into a log call anyway.

export type { Logger };

export const REDACT_PATHS = [
  'body',
  'req.body',
  'request.body',
  'res.body',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["idempotency-key"]',
  'headers["x-csrf-token"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'authorization',
  'cookie',
  'cookies',
  'password',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'idempotency_key',
  'idempotencyKey',
  'content',
  'prompt',
  '*.password',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.content',
  '*.prompt',
];

export interface LoggerOptions {
  /** Default `info`; `silent` turns logging off. */
  level?: string;
  /** Default stdout. Tests pass a memory stream. */
  destination?: DestinationStream;
  /** Component name, e.g. `api`. */
  name?: string;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  return pino(
    {
      name: options.name,
      level: options.level ?? 'info',
      base: undefined,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      // Error objects carry messages that can quote data (e.g. a duplicate-key value). Never serialise
      // them wholesale: callers log `err_name` and `err_code` instead.
      serializers: { err: () => '[omitted]' },
    },
    options.destination,
  );
}

/** One line per HTTP request. The only fields the API logs for a request. */
export interface AccessLogEntry {
  request_id: string;
  method: string;
  /** Route template (`/v1/projects/:projectId`), never the raw URL, which can hold tokens. */
  route: string;
  status: number;
  latency_ms: number;
  /** Database round trips made for the request, and their summed time. */
  db_round_trips?: number;
  db_ms?: number;
  user_id?: string;
  org_id?: string;
  /** Problem code for 4xx/5xx. */
  code?: string;
  /** Class name and SQLSTATE of an unexpected error; never its message or stack. */
  err_name?: string;
  err_code?: string;
}
