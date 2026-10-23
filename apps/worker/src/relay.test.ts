import { randomUUID } from 'node:crypto';
import type { JobExecutor, OutboxRecord, RelayDatabase } from '@parallelflow/db';
import { describe, expect, it, vi } from 'vitest';
import { defineConsumer } from './consumer.js';
import { OutboxRelay, routeTable, type JobSender } from './relay.js';
import { joinedEvent, memoryLogger } from './testing.js';

const ORG = randomUUID();

function record(event: ReturnType<typeof joinedEvent>): OutboxRecord {
  const { id, org_id, type, subject, actor, time, trace_id, schema_version, data } = event;
  return {
    id,
    org_id,
    topic: 'member',
    type,
    aggregate_id: subject,
    payload: { actor, time, trace_id, schema_version, data },
    created_at: new Date(),
  };
}

function fakeRelayDb(records: OutboxRecord[]) {
  const executor: JobExecutor = { executeSql: async () => ({ rows: [] }) };
  const relayDb = {
    publishBatch: vi.fn(
      async (_limit: number, enqueue: (r: OutboxRecord[], j: JobExecutor) => Promise<void>) => {
        await enqueue(records, executor);
        return records.length;
      },
    ),
  } as unknown as RelayDatabase;
  return { relayDb, executor };
}

const noop = async () => {};
const notify = defineConsumer({
  name: 'notify.fanout',
  events: ['member.joined', 'member.invited'],
  handler: noop,
});
const authz = defineConsumer({ name: 'authz.cache', events: ['member.joined'], handler: noop });
const setup = defineConsumer({
  name: 'runtime.setup',
  events: ['project.setup_completed'],
  handler: noop,
});

describe('routeTable', () => {
  it('maps each event type to every subscribed queue', () => {
    const routes = routeTable([notify, authz, setup]);
    expect(routes.get('member.joined')).toEqual(['consumer.notify.fanout', 'consumer.authz.cache']);
    expect(routes.get('member.invited')).toEqual(['consumer.notify.fanout']);
    expect(routes.get('project.setup_completed')).toEqual(['consumer.runtime.setup']);
  });
});

describe('OutboxRelay.tick', () => {
  it('enqueues one job per subscribed consumer, keyed by event id, in the relay transaction', async () => {
    const e1 = joinedEvent(ORG, randomUUID());
    const e2 = joinedEvent(ORG, randomUUID());
    const { relayDb, executor } = fakeRelayDb([record(e1), record(e2)]);
    const insert = vi.fn<JobSender['insert']>(async () => []);
    const { logger, lines } = memoryLogger();
    const relay = new OutboxRelay({
      relayDb,
      boss: { insert },
      consumers: [notify, authz, setup],
      logger,
      settings: { pollMs: 250, maxIdleMs: 2000, batchSize: 100 },
    });

    expect(await relay.tick()).toBe(2);
    expect(insert).toHaveBeenCalledTimes(2);
    for (const call of insert.mock.calls) {
      expect(call[1].map((j) => j.id)).toEqual([e1.id, e2.id]);
      expect(call[2].db).toBe(executor);
    }
    expect(insert.mock.calls.map((c) => c[0]).sort()).toEqual([
      'consumer.authz.cache',
      'consumer.notify.fanout',
    ]);
    expect(JSON.parse(lines().trim())).toMatchObject({
      msg: 'outbox.published',
      published: 2,
      jobs: 4,
    });
  });

  it('publishes an invalid row without jobs and logs ids only', async () => {
    const good = joinedEvent(ORG, randomUUID());
    const bad = {
      ...record(joinedEvent(ORG, randomUUID())),
      payload: { data: { note: 'secret words' } },
    };
    const { relayDb } = fakeRelayDb([bad, record(good)]);
    const insert = vi.fn<JobSender['insert']>(async () => []);
    const { logger, lines } = memoryLogger();
    const relay = new OutboxRelay({
      relayDb,
      boss: { insert },
      consumers: [authz],
      logger,
      settings: { pollMs: 250, maxIdleMs: 2000, batchSize: 100 },
    });
    expect(await relay.tick()).toBe(2);
    expect(insert.mock.calls[0]![1].map((j) => j.id)).toEqual([good.id]);
    expect(lines()).toContain('outbox.invalid_event');
    expect(lines()).toContain(bad.id);
    expect(lines()).not.toContain('secret words');
  });

  it('lets an enqueue failure abort the batch (the rows stay unpublished)', async () => {
    const { relayDb } = fakeRelayDb([record(joinedEvent(ORG, randomUUID()))]);
    const { logger } = memoryLogger();
    const relay = new OutboxRelay({
      relayDb,
      boss: { insert: async () => Promise.reject(new Error('db down')) },
      consumers: [authz],
      logger,
      settings: { pollMs: 250, maxIdleMs: 2000, batchSize: 100 },
    });
    await expect(relay.tick()).rejects.toThrow('db down');
  });
});
