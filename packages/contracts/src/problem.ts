import { z } from 'zod';

// RFC 7807 problem+json (openapi_v2.yaml #/components/schemas/Problem, doc 07 §7.4).

/** Stable machine codes. Clients switch on these; never rename one. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'MEMBERSHIP_INACTIVE',
  'SSO_REQUIRED',
  'HUMAN_ONLY_ACTION',
  'NOT_FOUND',
  'ALREADY_EXISTS',
  'CONFLICT',
  'LAST_OWNER',
  'ACTIVE_CYCLE_EXISTS',
  'WRONG_STAGE',
  'APPROVAL_CLOSED',
  'BRIDGE_SCOPE_MISMATCH',
  'ALREADY_BOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'INVITE_EXPIRED',
  'PRECONDITION_FAILED',
  'GATE_UNSTAFFED',
  'DISTINCT_ROLES_UNSATISFIABLE',
  'NO_OWNER',
  'AUTONOMY_ABOVE_CEILING',
  'SELF_APPROVAL_FORBIDDEN',
  'REASON_REQUIRED',
  'REQUIRED_ARTIFACT_MISSING',
  'ACCEPTANCE_CRITERIA_UNVERIFIED',
  'REVIEWER_REQUIRED',
  'MEMBER_LIMIT_REACHED',
  'CROSS_UNIT_NOT_ALLOWED',
  'GUEST_RESTRICTED',
  'CRON_TOO_FREQUENT',
  'RATE_LIMITED',
  'BUDGET_EXCEEDED',
  'RUNTIME_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** `type` URI of a problem: stable per code, not a resolvable page. */
export function problemType(code: ErrorCode): string {
  return `urn:parallelflow:problem:${code.toLowerCase()}`;
}

export const FieldErrorSchema = z.object({ field: z.string(), message: z.string() });
export type FieldError = z.infer<typeof FieldErrorSchema>;

export const ProblemSchema = z
  .object({
    type: z.string().url(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.enum(ERROR_CODES),
    detail: z.string().optional(),
    request_id: z.string().optional(),
    required_permission: z.string().optional(),
    errors: z.array(FieldErrorSchema).optional(),
  })
  .strict();
export type Problem = z.infer<typeof ProblemSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** `Idempotency-Key` header (openapi_v2.yaml #/components/parameters/IdempotencyKey). */
export const IdempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7e]+$/, 'Printable ASCII without spaces');
