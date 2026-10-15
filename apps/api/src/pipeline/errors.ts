import { HttpException } from '@nestjs/common';
import { MembershipInactiveError, NotVisibleError } from '@saras/db';
import { problemType, type ErrorCode, type FieldError, type Problem } from '@saras/contracts';
import { ZodError, type ZodIssue } from 'zod';

// Typed errors → RFC 7807 problem+json (doc 05 §5.11, doc 07 §7.4). Handlers and the pipeline throw
// ApiError (or a @saras/db error); the filter turns anything else into a generic 500.

const TITLES: Partial<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'Validation failed',
  UNAUTHENTICATED: 'Not signed in',
  FORBIDDEN: 'Not permitted',
  MEMBERSHIP_INACTIVE: 'Membership inactive',
  NOT_FOUND: 'Not found',
  ALREADY_EXISTS: 'Already exists',
  CONFLICT: 'Conflict',
  IDEMPOTENCY_KEY_REUSED: 'Idempotency key reused',
  PRECONDITION_FAILED: 'Precondition failed',
  RATE_LIMITED: 'Too many requests',
  INTERNAL_ERROR: 'Internal error',
};

const DEFAULT_DETAIL: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: 'Sign in to continue.',
  NOT_FOUND: 'Not found.',
  MEMBERSHIP_INACTIVE: 'Your membership here is not active.',
  INTERNAL_ERROR: 'Something went wrong. Try again with the same request id if it persists.',
};

export interface ApiErrorOptions {
  detail?: string;
  errors?: FieldError[];
  requiredPermission?: string;
  /** Extra response headers, e.g. Retry-After. */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly options: ApiErrorOptions = {},
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

export const notFound = () => new ApiError(404, 'NOT_FOUND');

export function validationFailed(errors: FieldError[], detail = 'The request is invalid.') {
  return new ApiError(400, 'VALIDATION_FAILED', { detail, errors });
}

export function fieldErrors(issues: readonly ZodIssue[]): FieldError[] {
  return issues.map((issue) => ({
    field: issue.path.length ? issue.path.join('.') : 'body',
    message: issue.message,
  }));
}

export interface MappedProblem {
  status: number;
  problem: Problem;
  headers: Record<string, string>;
  /** Set for unexpected errors only, for the access log. Never a message. */
  internal?: { name: string; code?: string };
}

function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

function classify(err: unknown): { error: ApiError; internal?: MappedProblem['internal'] } {
  if (err instanceof ApiError) return { error: err };
  if (err instanceof NotVisibleError) return { error: notFound() };
  if (err instanceof MembershipInactiveError)
    return { error: new ApiError(403, 'MEMBERSHIP_INACTIVE') };
  if (err instanceof ZodError) return { error: validationFailed(fieldErrors(err.issues)) };

  // Body parser (malformed JSON, body too large). Its messages quote the input, so never echo them.
  const parserType = (err as { type?: unknown } | null)?.type;
  if (typeof parserType === 'string' && parserType.startsWith('entity.')) {
    const tooLarge = parserType === 'entity.too.large';
    return {
      error: validationFailed(
        [{ field: 'body', message: tooLarge ? 'Too large' : 'Malformed' }],
        tooLarge ? 'The request body is too large.' : 'The request body is not valid JSON.',
      ),
    };
  }

  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status === 404 || status === 405) return { error: notFound() };
    if (status === 401) return { error: new ApiError(401, 'UNAUTHENTICATED') };
    if (status === 403) return { error: new ApiError(403, 'FORBIDDEN') };
    if (status === 400 || status === 413 || status === 415)
      return { error: validationFailed([], 'The request is invalid.') };
  }

  // Postgres errors reaching here were not handled by a module. Map the few with a safe meaning;
  // the SQL, constraint names and quoted values are never sent or logged.
  const state = sqlState(err);
  if (state === '42501') return { error: notFound() }; // RLS said no: not visible (doc 07 §7.1)
  if (state === '23505') return { error: new ApiError(409, 'ALREADY_EXISTS') };
  if (state === '40001' || state === '40P01' || state === '55P03') {
    return {
      error: new ApiError(409, 'CONFLICT', { detail: 'A concurrent change got in first. Retry.' }),
    };
  }

  const name = err instanceof Error ? err.constructor.name : typeof err;
  return {
    error: new ApiError(500, 'INTERNAL_ERROR'),
    internal: state ? { name, code: state } : { name },
  };
}

/** Pure mapping from anything thrown to the problem body, status and headers. */
export function toProblem(err: unknown, requestId: string): MappedProblem {
  const { error, internal } = classify(err);
  const { detail, errors, requiredPermission, headers } = error.options;
  const problem: Problem = {
    type: problemType(error.code),
    title: TITLES[error.code] ?? error.code,
    status: error.status,
    code: error.code,
    request_id: requestId,
  };
  const text = detail ?? DEFAULT_DETAIL[error.code];
  if (text) problem.detail = text;
  if (errors) problem.errors = errors;
  if (requiredPermission && error.status === 403) problem.required_permission = requiredPermission;
  return { status: error.status, problem, headers: headers ?? {}, ...(internal && { internal }) };
}
