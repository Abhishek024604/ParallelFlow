import type { DomainEvent, EventType } from '@parallelflow/contracts';
import { outboxRecordToEvent, type JobExecutor, type RelayDatabase } from '@parallelflow/db';
import type { Logger } from '@parallelflow/observability';
import { IdleBackoff } from './backoff.js';
import type { RelaySettings } from './config.js';
import { consumerQueue, type Consumer } from './consumer.js';

// Outbox relay (doc 05 §5.5, ADR-033). Claims unpublished outbox rows FOR UPDATE SKIP LOCKED and, in
// the same transaction, inserts one pg-boss job per subscribed consumer and marks the rows published.
// So a row is enqueued exactly once even with several relays: a second relay skips locked rows and
// never sees published ones; a crash before COMMIT leaves rows unpublished and enqueues nothing.
// Jobs use the event id as the job id, so a duplicate insert into the same queue is a no-op as well.
//
// Polling, not LISTEN/NOTIFY: 250 ms while busy, backing off to OUTBOX_IDLE_MAX_MS when idle
// (SLICE_DEBT). An idle poll is one query.

/** The pg-boss call the relay uses (PgBoss.insert). An interface so tests can fake it. */
export interface JobSender {
  insert(
    name: string,
    jobs: { id: string; data: object }[],
    options: { db: JobExecutor },
  ): Promise<unknown>;
}

/** Event type → consumer queues. */
export function routeTable(consumers: readonly Consumer[]): Map<EventType, string[]> {
  const routes = new Map<EventType, string[]>();
  for (const consumer of consumers) {
    for (const type of consumer.events) {
      routes.set(type, [...(routes.get(type) ?? []), consumerQueue(consumer)]);
    }
  }
  return routes;
}

export interface OutboxRelayOptions {
  relayDb: RelayDatabase;
  boss: JobSender;
  consumers: readonly Consumer[];
  logger: Logger;
  settings: RelaySettings;
}

export class OutboxRelay {
  private readonly routes: Map<EventType, string[]>;
  private readonly backoff: IdleBackoff;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly options: OutboxRelayOptions) {
    this.routes = routeTable(options.consumers);
    this.backoff = new IdleBackoff(options.settings.pollMs, options.settings.maxIdleMs);
  }

  /** One claim → enqueue → publish transaction. Returns the number of rows published. */
  async tick(): Promise<number> {
    const { relayDb, boss, logger, settings } = this.options;
    const started = Date.now();
    let jobs = 0;
    let invalid = 0;
    const published = await relayDb.publishBatch(settings.batchSize, async (records, db) => {
      jobs = 0;
      invalid = 0;
      const byQueue = new Map<string, { id: string; data: DomainEvent }[]>();
      for (const record of records) {
        let event: DomainEvent;
        try {
          event = outboxRecordToEvent(record);
        } catch {
          // Only raw SQL can write such a row (emit validates). Publishing it with no jobs keeps one
          // bad row from blocking the outbox; the log line lets someone find it (ids only).
          invalid++;
          logger.error(
            { event_id: record.id, event_type: record.type, org_id: record.org_id },
            'outbox.invalid_event',
          );
          continue;
        }
        for (const queue of this.routes.get(event.type) ?? []) {
          const list = byQueue.get(queue) ?? [];
          list.push({ id: event.id, data: event });
          byQueue.set(queue, list);
        }
      }
      for (const [queue, list] of byQueue) {
        await boss.insert(queue, list, { db });
        jobs += list.length;
      }
    });
    if (published > 0) {
      logger.info(
        { published, jobs, invalid, duration_ms: Date.now() - started },
        'outbox.published',
      );
    }
    return published;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling and waits for a transaction in flight to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.poll();
    }, delay);
  }

  private async poll(): Promise<void> {
    let delay: number;
    try {
      const published = await this.tick();
      delay = this.backoff.afterPoll(published, this.options.settings.batchSize);
    } catch (err) {
      const e = err as { name?: string; code?: string };
      this.options.logger.error(
        { err_name: e?.name ?? 'Error', ...(e?.code && { err_code: e.code }) },
        'outbox.relay_failed',
      );
      delay = this.backoff.afterError();
    }
    this.schedule(delay);
  }
}
