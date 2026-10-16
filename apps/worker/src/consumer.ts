import { EVENT_TYPES, parseDomainEvent, type DomainEvent, type EventType } from '@saras/contracts';
import { markProcessed, type Database, type Tx } from '@saras/db';
import type { Logger } from '@saras/observability';
import { retryPolicy, type RetryPolicy } from './backoff.js';

// Idempotent event consumers (doc 07 §7.5, F21-05). Each consumer has its own pg-boss queue; the
// relay puts one job per subscribed event into it. A job run:
//   1. re-validates the event against the registry (ids only);
//   2. opens withSystemJob for the event's org (the app role, saras_app: RLS still applies);
//   3. in that transaction inserts (consumer, event_id) into processed_events, ON CONFLICT DO NOTHING.
//      Already there → the event was handled before: skip. Otherwise run the handler;
//   4. commits the marker and the handler's writes together.
// A handler that throws rolls both back; pg-boss retries with exponential backoff and, after
// `retryLimit`, moves the job to the consumer's dead-letter queue. Logs carry ids only.

export interface ConsumerContext {
  /** The withSystemJob transaction for the event's org. Write through it so writes commit with the marker. */
  tx: Tx;
  logger: Logger;
}

export interface Consumer<T extends EventType = EventType> {
  name: string;
  events: readonly T[];
  retry: RetryPolicy;
  handler(event: DomainEvent<T>, ctx: ConsumerContext): Promise<void>;
}

export interface ConsumerDefinition<T extends EventType> {
  /** Lower case, digits and `_`, dot-separated (`notify.fanout`). Also the processed_events key. */
  name: string;
  events: readonly T[];
  handler(event: DomainEvent<T>, ctx: ConsumerContext): Promise<void>;
  retry?: Partial<RetryPolicy>;
}

const CONSUMER_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

export function defineConsumer<T extends EventType>(
  definition: ConsumerDefinition<T>,
): Consumer<T> {
  const { name, events, handler } = definition;
  if (!CONSUMER_NAME.test(name) || name.length > 60) {
    throw new Error(`Consumer name must be dot-separated lower-case words: ${name}`);
  }
  if (events.length === 0) throw new Error(`Consumer ${name} subscribes to no events`);
  for (const type of events) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`Consumer ${name}: unknown event ${type}`);
  }
  return { name, events: [...new Set(events)], handler, retry: retryPolicy(definition.retry) };
}

/** The pg-boss queue a consumer reads. */
export const consumerQueue = (consumer: Pick<Consumer, 'name'>) => `consumer.${consumer.name}`;
/** Where its jobs go after the last retry. Kept for inspection and `redrive`, never auto-processed. */
export const deadLetterQueue = (consumer: Pick<Consumer, 'name'>) =>
  `consumer.${consumer.name}.dead`;

/** Rejects consumer sets that would share a queue or a processed_events key. */
export function assertUniqueConsumers(consumers: readonly Consumer[]): void {
  const seen = new Set<string>();
  for (const { name } of consumers) {
    if (seen.has(name)) throw new Error(`Duplicate consumer name: ${name}`);
    seen.add(name);
  }
}

/** The parts of a pg-boss job (fetched with includeMetadata) a run needs. */
export interface ConsumerJob {
  id: string;
  data: unknown;
  retryCount: number;
  retryLimit: number;
}

/**
 * Thrown to pg-boss when a run fails. pg-boss stores it on the job, so it names ids and the error
 * class only, never the original message (which can quote data).
 */
export class ConsumerFailedError extends Error {
  constructor(consumer: string, jobId: string, cause: { name: string; code?: string }) {
    super(
      `Consumer ${consumer} failed on job ${jobId}: ${cause.name}${cause.code ? ` (${cause.code})` : ''}`,
    );
    this.name = 'ConsumerFailedError';
  }
}

export type RunOutcome = 'processed' | 'duplicate';

const describe = (err: unknown): { name: string; code?: string } => {
  const e = err as { name?: unknown; code?: unknown };
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  return typeof e?.code === 'string' ? { name, code: e.code } : { name };
};

/** Runs one job for one consumer. Throws ConsumerFailedError so pg-boss retries it. */
export async function runConsumerJob(
  db: Database,
  consumer: Consumer,
  job: ConsumerJob,
  logger: Logger,
): Promise<RunOutcome> {
  const started = Date.now();
  const attempt = job.retryCount + 1;
  const final = job.retryCount >= job.retryLimit;
  let ids: Record<string, string> = { consumer: consumer.name, job_id: job.id };
  try {
    const event = parseDomainEvent(job.data);
    ids = { ...ids, event_id: event.id, event_type: event.type, org_id: event.org_id };
    if (!consumer.events.includes(event.type)) {
      throw Object.assign(new Error('Event type not subscribed'), { name: 'UnsubscribedEvent' });
    }
    const outcome = await db.withSystemJob({ orgId: event.org_id }, async (tx) => {
      if (!(await markProcessed(tx, consumer.name, event.id))) return 'duplicate' as const;
      await consumer.handler(event, { tx, logger });
      return 'processed' as const;
    });
    logger.info({ ...ids, outcome, attempt, duration_ms: Date.now() - started }, 'consumer.done');
    return outcome;
  } catch (err) {
    const cause = describe(err);
    logger[final ? 'error' : 'warn'](
      {
        ...ids,
        attempt,
        duration_ms: Date.now() - started,
        err_name: cause.name,
        ...(cause.code && { err_code: cause.code }),
        dead_lettered: final,
      },
      final ? 'consumer.dead_lettered' : 'consumer.failed',
    );
    throw new ConsumerFailedError(consumer.name, job.id, cause);
  }
}
