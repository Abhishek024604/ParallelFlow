import {
  EVENT_SCHEMA_VERSION,
  eventTopic,
  parseDomainEvent,
  uuidv7,
  type DomainEvent,
  type EventType,
  type NewDomainEvent,
} from '@parallelflow/contracts';
import { sql } from 'kysely';
import type { Tx } from './database.js';

// Transactional outbox (doc 05 §5.4–5.5, doc 07 §7.5, F21-05). A producer calls `emit(tx, event)`
// inside the transaction that makes the change, so the event commits or rolls back with it. The worker
// relays committed rows to pg-boss (createRelayDatabase, ADR-033).
//
// Envelope → `outbox_events` columns (schema_v2 unchanged):
//   id → id · org_id → org_id · type → type · topic = the type's prefix (`member.joined` → `member`)
//   subject → aggregate_id · {actor, time, trace_id, schema_version, data} → payload
// `created_at` is the insert time (relay order); the envelope keeps its own `time`.

/** The event's org_id is not the transaction's tenant (doc 07 §7.5, rule 1). Nothing was written. */
export class OutboxTenantMismatchError extends Error {
  readonly code = 'OUTBOX_TENANT_MISMATCH';
  constructor() {
    super("Event org_id does not match the transaction's tenant");
    this.name = 'OutboxTenantMismatchError';
  }
}

/** The payload column, as written by `emit`. */
interface OutboxPayload {
  actor: DomainEvent['actor'];
  time: string;
  trace_id: string | null;
  schema_version: number;
  data: unknown;
}

/** One `outbox_events` row as the relay reads it. */
export interface OutboxRecord {
  id: string;
  org_id: string;
  topic: string;
  type: string;
  aggregate_id: string;
  payload: unknown;
  created_at: Date;
}

/**
 * Writes a domain event to the outbox in the caller's transaction and returns the full envelope.
 * Validates it against the event registry (ids only, size cap) and requires `org_id` to be the
 * transaction's tenant: the insert is conditional on it, so a mismatch writes nothing and throws
 * OutboxTenantMismatchError (RLS would also reject it). One round trip.
 */
export async function emit<T extends EventType>(
  tx: Tx,
  input: NewDomainEvent<T>,
): Promise<DomainEvent<T>> {
  const event = parseDomainEvent({
    ...input,
    id: uuidv7(),
    time: new Date().toISOString(),
    trace_id: input.trace_id ?? null,
    schema_version: EVENT_SCHEMA_VERSION,
  }) as DomainEvent<T>;

  const payload: OutboxPayload = {
    actor: event.actor,
    time: event.time,
    trace_id: event.trace_id,
    schema_version: event.schema_version,
    data: event.data,
  };
  const { rows } = await sql<{ id: string }>`
    INSERT INTO outbox_events (id, org_id, topic, type, aggregate_id, payload)
    SELECT ${event.id}, ${event.org_id}, ${eventTopic(event.type as EventType)}, ${event.type}, ${event.subject},
           ${JSON.stringify(payload)}::jsonb
    WHERE ${event.org_id}::uuid = saras.current_org_id()
    RETURNING id`.execute(tx);
  if (rows.length !== 1) throw new OutboxTenantMismatchError();
  return event;
}

/**
 * Rebuilds and re-validates the envelope of an outbox row. Throws InvalidEventError (paths only)
 * for a row that was not written by `emit` or no longer matches the registry.
 */
export function outboxRecordToEvent(record: OutboxRecord): DomainEvent {
  const payload = (record.payload ?? {}) as Partial<OutboxPayload>;
  return parseDomainEvent({
    id: record.id,
    type: record.type,
    org_id: record.org_id,
    subject: record.aggregate_id,
    actor: payload.actor,
    time: payload.time,
    trace_id: payload.trace_id,
    schema_version: payload.schema_version,
    data: payload.data,
  });
}

/**
 * Consumer idempotency (doc 07 §7.5): records `(consumer, event_id)` in `processed_events` in the
 * caller's transaction. Returns false when it was already there, so the caller skips the handler.
 * Commit it together with the handler's writes.
 */
export async function markProcessed(tx: Tx, consumer: string, eventId: string): Promise<boolean> {
  const { rows } = await sql`
    INSERT INTO processed_events (consumer, event_id) VALUES (${consumer}, ${eventId})
    ON CONFLICT (consumer, event_id) DO NOTHING
    RETURNING 1`.execute(tx);
  return rows.length === 1;
}
