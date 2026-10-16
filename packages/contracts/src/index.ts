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
export { UUID_V7_PATTERN, uuidv7 } from './ids.js';
export {
  DomainEventSchema,
  EVENT_DATA,
  EVENT_SCHEMA_VERSION,
  EVENT_TYPES,
  EventActorSchema,
  eventTopic,
  InvalidEventError,
  MAX_EVENT_BYTES,
  parseDomainEvent,
  withinEventSizeLimit,
} from './events.js';
export type { DomainEvent, EventActor, EventData, EventType, NewDomainEvent } from './events.js';
export {
  CreateArenaSchema,
  formatInviteToken,
  INVITE_SECRET_BYTES,
  INVITE_TOKEN_PATTERN,
  INVITE_TTL_DAYS,
  InviteEmailSchema,
  MAX_INVITE_EMAILS,
  parseInviteToken,
  SDLC_STAGES,
} from './arenas.js';
export type {
  AcceptInviteArena,
  ArenaDetail,
  ArenaInvite,
  ArenaList,
  ArenaSummary,
  CreateArena,
  CreateArenaInput,
  CreateArenaResponse,
  CreatedInvite,
  InvitePreview,
  InviteToken,
  SdlcStage,
} from './arenas.js';
