import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '@saras/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertUniqueConsumers,
  ConsumerFailedError,
  consumerQueue,
  deadLetterQueue,
  defineConsumer,
  runConsumerJob,
} from './consumer.js';
import { joinedEvent, memoryLogger } from './testing.js';

const marked = new Set<string>();
vi.mock('@saras/db', async (original) => ({
  ...(await original<typeof import('@saras/db')>()),
  // In-memory processed_events: the real one is covered by consumer.int.test.ts.
  markProcessed: vi.fn(async (_tx: Tx, consumer: string, eventId: string) => {
    const key = `${consumer}:${eventId}`;
    if (marked.has(key)) return false;
    marked.add(key);
    return true;
  }),
}));

function fakeDb() {
  const orgs: string[] = [];
  const db = {
    withSystemJob: vi.fn(async (ctx: { orgId: string }, fn: (tx: Tx) => Promise<unknown>) => {
      orgs.push(ctx.orgId);
      const before = new Set(marked);
      try {
        return await fn({} as Tx);
      } catch (err) {
        // Roll back the in-memory marker like the transaction would.
        for (const k of [...marked]) if (!before.has(k)) marked.delete(k);
        throw err;
      }
    }),
  } as unknown as Database;
  return { db, orgs };
}

const ORG = randomUUID();
const USER = randomUUID();

describe('defineConsumer', () => {
  it('names queues after the consumer and applies the default retry policy', () => {
    const c = defineConsumer({
      name: 'notify.fanout',
      events: ['member.joined'],
      handler: async () => {},
    });
    expect(consumerQueue(c)).toBe('consumer.notify.fanout');
    expect(deadLetterQueue(c)).toBe('consumer.notify.fanout.dead');
    expect(c.retry.retryBackoff).toBe(true);
  });

  it.each([
    ['bad name', { name: 'Notify Fanout', events: ['member.joined'] }],
    ['no events', { name: 'x', events: [] }],
    ['unknown event', { name: 'x', events: ['member.vanished'] }],
  ])('rejects %s', (_label, def) => {
    expect(() =>
      defineConsumer({
        ...(def as { name: string; events: ['member.joined'] }),
        handler: async () => {},
      }),
    ).toThrow();
  });

  it('rejects two consumers with one name', () => {
    const c = defineConsumer({ name: 'a', events: ['member.joined'], handler: async () => {} });
    expect(() => assertUniqueConsumers([c, c])).toThrow(/Duplicate/);
  });
});

describe('runConsumerJob', () => {
  beforeEach(() => marked.clear());

  it('runs the handler once per event, in the event org, and skips duplicates', async () => {
    const handler = vi.fn(async () => {});
    const consumer = defineConsumer({ name: 'test.once', events: ['member.joined'], handler });
    const { db, orgs } = fakeDb();
    const { logger } = memoryLogger();
    const event = joinedEvent(ORG, USER);
    const job = { id: randomUUID(), data: event, retryCount: 0, retryLimit: 3 };

    expect(await runConsumerJob(db, consumer, job, logger)).toBe('processed');
    expect(await runConsumerJob(db, consumer, { ...job, id: randomUUID() }, logger)).toBe(
      'duplicate',
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(orgs).toEqual([ORG, ORG]);
  });

  it('throws an ids-only error so pg-boss retries, and the handler runs again on retry', async () => {
    let calls = 0;
    const consumer = defineConsumer({
      name: 'test.flaky',
      events: ['member.joined'],
      handler: async () => {
        calls++;
        if (calls === 1) throw new Error('duplicate key (email)=(x@secret.test)');
      },
    });
    const { db } = fakeDb();
    const { logger, lines } = memoryLogger();
    const job = { id: randomUUID(), data: joinedEvent(ORG, USER), retryCount: 0, retryLimit: 3 };

    const err = await runConsumerJob(db, consumer, job, logger).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConsumerFailedError);
    expect((err as Error).message).not.toContain('secret.test');
    expect(lines()).toContain('consumer.failed');
    expect(lines()).not.toContain('secret.test');

    // The marker rolled back with the failure, so the retry runs the handler.
    expect(await runConsumerJob(db, consumer, { ...job, retryCount: 1 }, logger)).toBe('processed');
    expect(calls).toBe(2);
  });

  it('logs the last failed attempt as dead-lettered', async () => {
    const consumer = defineConsumer({
      name: 'test.broken',
      events: ['member.joined'],
      handler: async () => {
        throw new TypeError('nope');
      },
    });
    const { db } = fakeDb();
    const { logger, lines } = memoryLogger();
    const job = { id: randomUUID(), data: joinedEvent(ORG, USER), retryCount: 3, retryLimit: 3 };
    await expect(runConsumerJob(db, consumer, job, logger)).rejects.toThrow(ConsumerFailedError);
    const line = JSON.parse(lines().trim().split('\n').at(-1)!);
    expect(line).toMatchObject({
      msg: 'consumer.dead_lettered',
      consumer: 'test.broken',
      attempt: 4,
      err_name: 'TypeError',
      dead_lettered: true,
    });
  });

  it('rejects an invalid or unsubscribed event before opening a transaction', async () => {
    const consumer = defineConsumer({
      name: 'test.strict',
      events: ['member.invited'],
      handler: async () => {},
    });
    const { db, orgs } = fakeDb();
    const { logger, lines } = memoryLogger();
    const bad = { ...joinedEvent(ORG, USER), data: { user_id: USER, note: 'private words' } };
    await expect(
      runConsumerJob(
        db,
        consumer,
        { id: randomUUID(), data: bad, retryCount: 0, retryLimit: 1 },
        logger,
      ),
    ).rejects.toThrow(ConsumerFailedError);
    await expect(
      runConsumerJob(
        db,
        consumer,
        { id: randomUUID(), data: joinedEvent(ORG, USER), retryCount: 0, retryLimit: 1 },
        logger,
      ),
    ).rejects.toThrow(ConsumerFailedError);
    expect(orgs).toEqual([]);
    expect(lines()).not.toContain('private words');
  });
});
