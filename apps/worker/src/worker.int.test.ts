import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '@saras/contracts';
import {
  createDatabase,
  createRelayDatabase,
  emit,
  JOB_SCHEMA,
  type RelayDatabase,
} from '@saras/db';
import {
  createTenantFixture,
  createTestDatabase,
  integrationEnabled,
  query,
  type TenantFixture,
  type TestDatabase,
} from '@saras/db/testing';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consumerQueue, deadLetterQueue, defineConsumer, type Consumer } from './consumer.js';
import { OutboxRelay } from './relay.js';
import { joinedEvent, memoryLogger } from './testing.js';
import { startWorker, type RunningWorker } from './worker.js';

// F21-05 end to end against a real Postgres: emit → relay (two at once) → pg-boss → idempotent
// consumers with retries and a dead-letter queue. pg-boss runs as the relay login, as in production.

const enabled = await integrationEnabled();

const SETTINGS = { pollMs: 250, maxIdleMs: 1000, batchSize: 5 };
const SECRET = 'SECRET-HANDLER-DETAIL';

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 250));
  }
}

const newBoss = (url: string) =>
  new PgBoss({
    connectionString: url,
    schema: JOB_SCHEMA,
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    reindex: false,
    max: 3,
  });

async function emitJoined(t: TestDatabase, f: TenantFixture, n: number): Promise<DomainEvent[]> {
  // One transaction for all of them: n round trips, not n transactions.
  return t.db.withSystemJob({ orgId: f.orgId }, async (tx) => {
    const events: DomainEvent[] = [];
    for (let i = 0; i < n; i++) {
      events.push(
        await emit(tx, {
          type: 'member.joined',
          org_id: f.orgId,
          subject: f.users.member,
          actor: { type: 'system', id: null, on_behalf_of: null },
          data: { user_id: f.users.member, invitation_id: null, project_id: f.projectId },
        }),
      );
    }
    return events;
  });
}

describe.skipIf(!enabled)('worker: relay, consumers, retries (F21-05)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  const log = memoryLogger();
  const handled: Record<string, string[]> = { counted: [], flaky: [], broken: [] };
  const attemptsAt: number[] = [];
  let worker: RunningWorker;
  let boss: PgBoss;

  const counted = defineConsumer({
    name: 'test.counted',
    events: ['member.joined'],
    handler: async (event) => {
      handled.counted!.push(event.id);
    },
  });
  // Fails its first attempt, then succeeds.
  const flaky = defineConsumer({
    name: 'test.flaky',
    events: ['member.invited'],
    retry: { retryLimit: 3, retryDelay: 1, retryDelayMax: 4 },
    handler: async (event) => {
      attemptsAt.push(Date.now());
      handled.flaky!.push(event.id);
      if (handled.flaky!.length === 1) throw new Error(SECRET);
    },
  });
  // Always fails: lands in the dead-letter queue after one retry.
  const broken = defineConsumer({
    name: 'test.broken',
    events: ['project.setup_completed'],
    retry: { retryLimit: 1, retryDelay: 1, retryDelayMax: 2 },
    handler: async (event) => {
      handled.broken!.push(event.id);
      throw new Error(SECRET);
    },
  });
  const consumers: Consumer[] = [counted, flaky, broken];

  beforeAll(async () => {
    t = await createTestDatabase({ relay: true });
    a = await createTenantFixture(t.db, 'w');
    boss = newBoss(t.relayUrl!);
    // The worker owns (and closes) its pools; give it its own so the test keeps t.db.
    worker = await startWorker({
      db: createDatabase({ connectionString: t.appUrl }),
      relayDb: createRelayDatabase({ connectionString: t.relayUrl! }),
      boss,
      consumers,
      logger: log.logger,
      relay: SETTINGS,
      pollingIntervalSeconds: 0.5,
      housekeeping: [],
      startRelay: false,
    });
  });

  afterAll(async () => {
    await worker?.stop();
    await t?.cleanup();
  });

  it('refuses to start with the owner or the app login as relay role', async () => {
    for (const url of [t.ownerUrl, t.appUrl]) {
      const relayDb = createRelayDatabase({ connectionString: url });
      const db = createDatabase({ connectionString: t.appUrl });
      try {
        await expect(
          startWorker({
            db,
            relayDb,
            boss: newBoss(t.relayUrl!),
            consumers: [],
            logger: log.logger,
            relay: SETTINGS,
            housekeeping: [],
            startRelay: false,
          }),
        ).rejects.toThrow(/Unsafe relay database role/);
      } finally {
        await relayDb.destroy();
        await db.destroy();
      }
    }
  });

  it('two relays at once publish every event exactly once', async () => {
    const events = await emitJoined(t, a, 12);
    const ids = events.map((e) => e.id);
    const relays: RelayDatabase[] = [
      createRelayDatabase({ connectionString: t.relayUrl! }),
      createRelayDatabase({ connectionString: t.relayUrl! }),
    ];
    try {
      const drain = async (relayDb: RelayDatabase) => {
        const relay = new OutboxRelay({
          relayDb,
          boss,
          consumers,
          logger: log.logger,
          settings: SETTINGS,
        });
        let total = 0;
        for (let n = await relay.tick(); n > 0; n = await relay.tick()) total += n;
        return total;
      };
      const [first, second] = await Promise.all(relays.map(drain));
      // The fixture's own outbox row (an unregistered type) is published too, without jobs.
      expect(first! + second!).toBeGreaterThanOrEqual(ids.length);
    } finally {
      await Promise.all(relays.map((r) => r.destroy()));
    }

    const published = await query<{ n: number }>(
      t.ownerUrl,
      'SELECT count(*)::int AS n FROM saras.outbox_events WHERE id = ANY($1) AND published_at IS NOT NULL',
      [ids],
    );
    expect(published.rows[0]!.n).toBe(ids.length);
    const jobs = await query<{ id: string }>(
      t.ownerUrl,
      `SELECT id FROM ${JOB_SCHEMA}.job WHERE name = $1 AND id = ANY($2)`,
      [consumerQueue(counted), ids],
    );
    expect(jobs.rows.map((r) => r.id).sort()).toEqual([...ids].sort());

    // Consumers then handle each event once.
    await waitFor(() => ids.every((id) => handled.counted!.includes(id)));
    expect(handled.counted!.filter((id) => ids.includes(id))).toHaveLength(ids.length);
  });

  it('a consumer receiving the same event twice runs its handler once', async () => {
    const [event] = await emitJoined(t, a, 1);
    const relayDb = createRelayDatabase({ connectionString: t.relayUrl! });
    try {
      await new OutboxRelay({
        relayDb,
        boss,
        consumers,
        logger: log.logger,
        settings: SETTINGS,
      }).tick();
    } finally {
      await relayDb.destroy();
    }
    await waitFor(() => handled.counted!.includes(event!.id));

    // Redeliver: a second job with the same event under a new job id.
    const dup = await boss.send(consumerQueue(counted), event!, { id: randomUUID() });
    await waitFor(async () => {
      const [job] = await boss.findJobs(consumerQueue(counted), { id: dup! });
      return job?.state === 'completed';
    });
    expect(handled.counted!.filter((id) => id === event!.id)).toHaveLength(1);
    const marks = await query<{ n: number }>(
      t.ownerUrl,
      'SELECT count(*)::int AS n FROM saras.processed_events WHERE consumer = $1 AND event_id = $2',
      [counted.name, event!.id],
    );
    expect(marks.rows[0]!.n).toBe(1);
  });

  it('a failing handler is retried with backoff, then succeeds', async () => {
    const event = { ...joinedEvent(a.orgId, a.users.owner) } as unknown as DomainEvent;
    const invited: DomainEvent = {
      ...event,
      type: 'member.invited',
      data: { invitation_id: randomUUID(), project_id: null },
    } as DomainEvent;
    await boss.send(consumerQueue(flaky), invited, { id: invited.id });
    await waitFor(() => handled.flaky!.length >= 2);
    expect(handled.flaky).toEqual([invited.id, invited.id]);
    // retryDelay 1 s with backoff: pg-boss waits at least half of it before the retry.
    expect(attemptsAt[1]! - attemptsAt[0]!).toBeGreaterThanOrEqual(500);
    await waitFor(async () => {
      const [job] = await boss.findJobs(consumerQueue(flaky), { id: invited.id });
      return job?.state === 'completed';
    });
  });

  it('after retryLimit the job lands in the dead-letter queue, logged and stored with ids only', async () => {
    const id = randomUUID();
    const event = {
      ...joinedEvent(a.orgId, a.users.owner),
      type: 'project.setup_completed',
      subject: a.projectId,
      data: { project_id: a.projectId, arena_id: a.arenaId },
    } as unknown as DomainEvent;
    await boss.send(consumerQueue(broken), event, { id });
    await waitFor(async () => (await boss.findJobs(deadLetterQueue(broken))).length > 0);

    expect(handled.broken).toEqual([event.id, event.id]); // 1 try + retryLimit 1
    const [dead] = await boss.findJobs(deadLetterQueue(broken));
    expect((dead!.data as DomainEvent).id).toBe(event.id);

    const out = log.lines();
    expect(out).toContain('consumer.dead_lettered');
    expect(out).not.toContain(SECRET);
    // pg-boss stores the thrown error on the job: ConsumerFailedError carries ids only.
    const stored = await query<{ output: unknown }>(
      t.ownerUrl,
      `SELECT output FROM ${JOB_SCHEMA}.job WHERE name = $1 AND id = $2`,
      [consumerQueue(broken), id],
    );
    expect(JSON.stringify(stored.rows)).not.toContain(SECRET);
  });

  it('logs no payload content', () => {
    // Events carry ids only; logs carry ids, types, counts and durations. No handler error text,
    // no event `data` object.
    const out = log.lines();
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('"data"');
    expect(out).not.toContain('"payload"');
  });
});
