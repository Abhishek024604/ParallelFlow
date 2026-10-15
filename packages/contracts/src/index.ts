// Zod schemas, OpenAPI v2, RIC types, event types, role templates (doc 05 §5.3).
export const workspace = '@saras/contracts' as const;

export {
  ERROR_CODES,
  FieldErrorSchema,
  IdempotencyKeySchema,
  PROBLEM_CONTENT_TYPE,
  ProblemSchema,
  problemType,
} from './problem.js';
export type { ErrorCode, FieldError, Problem } from './problem.js';
export {
  HANDLE_PATTERN,
  MeSchema,
  OrganizationSchema,
  OrgRoleSchema,
  UpdateMeSchema,
} from './identity.js';
export type { Me, Organization, UpdateMe } from './identity.js';
