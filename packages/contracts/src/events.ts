import { z } from 'zod';
import { UUID_V7_PATTERN } from './ids.js';

// Domain events (doc 07 §7.5): written to `outbox_events` in the transaction that made the change,
// relayed to pg-boss consumer queues by the worker (F21-05, ADR-017).
//
// Envelope: {id, type, org_id, subject, actor{type,id,on_behalf_of}, time, trace_id, schema_version,
// data}. Consumers are idempotent on `id`.
//
// Events carry ids only, never message or artifact content, names, emails or prompts (CLAUDE.md
// rule 7): consumers load what they need inside their own tenant context. The schemas enforce it:
// every object is strict, every `data` field is an id or an enum, and the whole event is capped at
// MAX_EVENT_BYTES. Adding an event type means adding it to EVENT_DATA below, nothing else.

export const EVENT_SCHEMA_VERSION = 1;

/** Serialized size cap for one event (UTF-8 bytes of its JSON). Ids-only events are far smaller. */
export const MAX_EVENT_BYTES = 4096;

const Id = z.string().uuid();
const NullableId = Id.nullable();

/** Who caused the event. `on_behalf_of` is set when an agent acts for a user. */
export const EventActorSchema = z
  .object({
    type: z.enum(['user', 'agent', 'system']),
    id: NullableId,
    on_behalf_of: NullableId,
  })
  .strict();
export type EventActor = z.infer<typeof EventActorSchema>;

/**
 * The typed event registry: `type` → schema of `data`. Ids and enums only. Start small; add types as
 * the stories that emit them land (doc 07 §7.5 lists the full catalogue).
 */
export const EVENT_DATA = {
  /** Arena setup finished (create arena, ADR-029): provision the AI session, routines, notify. */
  'project.setup_completed': z.object({ project_id: Id, arena_id: Id }).strict(),
  /** An invitation was created. The email stays in `invitations`; it is never in the event. */
  'member.invited': z.object({ invitation_id: Id, project_id: NullableId }).strict(),
  /** An invitee accepted and became a member. */
  'member.joined': z
    .object({ user_id: Id, invitation_id: NullableId, project_id: NullableId })
    .strict(),
} as const;

export type EventType = keyof typeof EVENT_DATA;
export const EVENT_TYPES = Object.keys(EVENT_DATA) as EventType[];
export type EventData<T extends EventType> = z.infer<(typeof EVENT_DATA)[T]>;

const TRACE_ID = /^[0-9a-f]{32}$/;

const envelope = <T extends EventType>(type: T) =>
  z
    .object({
      id: z.string().regex(UUID_V7_PATTERN, 'Must be a lower-case UUIDv7'),
      type: z.literal(type),
      org_id: Id,
      /** The aggregate the event is about (stored as `outbox_events.aggregate_id`). */
      subject: Id,
      actor: EventActorSchema,
      time: z.string().datetime({ offset: true }),
      /** W3C trace id (32 lower-case hex), or null outside a traced request. */
      trace_id: z.string().regex(TRACE_ID).nullable(),
      schema_version: z.literal(EVENT_SCHEMA_VERSION),
      data: EVENT_DATA[type],
    })
    .strict();

type EnvelopeSchema<T extends EventType> = ReturnType<typeof envelope<T>>;
type EventSchemas = { [T in EventType]: EnvelopeSchema<T> }[EventType];

const schemas = EVENT_TYPES.map((type) => envelope(type)) as unknown as [
  EventSchemas,
  EventSchemas,
  ...EventSchemas[],
];

/** Whether the JSON of `value` fits in MAX_EVENT_BYTES (UTF-8). Also checked by `emit` and the relay. */
export function withinEventSizeLimit(value: unknown): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_EVENT_BYTES;
}

/** A domain event of any registered type. Unknown types, unknown fields and oversize events fail. */
export const DomainEventSchema = z.discriminatedUnion('type', schemas).superRefine((event, ctx) => {
  if (!withinEventSizeLimit(event)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `Event is larger than ${MAX_EVENT_BYTES} bytes`,
    });
  }
});

export type DomainEvent<T extends EventType = EventType> = {
  [K in T]: z.infer<EnvelopeSchema<K>>;
}[T];

/** What a producer supplies; `id`, `time` and `schema_version` are filled in by `emit`. */
export type NewDomainEvent<T extends EventType = EventType> = {
  [K in T]: Omit<DomainEvent<K>, 'id' | 'time' | 'schema_version' | 'trace_id'> & {
    trace_id?: string | null;
  };
}[T];

/** Thrown for an event that does not match the registry. Names the paths, never the values. */
export class InvalidEventError extends Error {
  readonly code = 'INVALID_EVENT';
  constructor(readonly paths: string[]) {
    super(`Invalid domain event at: ${paths.join(', ') || '(root)'}`);
    this.name = 'InvalidEventError';
  }
}

/** Validates an event and returns it typed. Throws InvalidEventError (paths only, no values). */
export function parseDomainEvent(input: unknown): DomainEvent {
  const result = DomainEventSchema.safeParse(input);
  if (!result.success) {
    throw new InvalidEventError(result.error.issues.map((i) => i.path.join('.')));
  }
  return result.data as DomainEvent;
}

/** `member.joined` → `member`. Stored as `outbox_events.topic`. */
export function eventTopic(type: EventType): string {
  return type.slice(0, type.indexOf('.'));
}
