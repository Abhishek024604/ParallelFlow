import { randomUUID } from 'node:crypto';
import { uuidv7, type NewDomainEvent } from '@parallelflow/contracts';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Tx } from './database.js';
import { emit, OutboxTenantMismatchError } from './outbox.js';
import { createRelayDatabase } from './relay.js';
import {
  createTestDatabase,
  integrationEnabled,
  query,
  type TestDatabase,
} from './testing/database.js';
import { createTenantFixture, type TenantFixture } from './testing/fixture.js';

// F21-05 / ADR-033: emitting in the caller's transaction, and the saras_relay boundary (migration
// 0005). The relay sees outbox rows of every org and nothing else; the app role still sees one org.
// Round trips are kept low (Neon ~0.5 s each): one connection per role, one statement per check.

const enabled = await integrationEnabled();

const joined = (orgId: string, userId: string): NewDomainEvent<'member.joined'> => ({
  type: 'member.joined',
  org_id: orgId,
  subject: userId,
  actor: { type: 'user', id: userId, on_behalf_of: null },
  data: { user_id: userId, invitation_id: null, project_id: null },
});

async function code(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return 'ok';
  } catch (err) {
    return (err as { code?: string }).code ?? (err as Error).name;
  }
}

const outboxIds = async (url: string, ids: string[]) =>
  (
    await query<{ id: string }>(url, 'SELECT id FROM saras.outbox_events WHERE id = ANY($1)', [ids])
  ).rows.map((r) => r.id);

describe.skipIf(!enabled)('outbox emit and relay role (ADR-033)', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  let relayClient: pg.Client;

  beforeAll(async () => {
    t = await createTestDatabase({ relay: true });
    a = await createTenantFixture(t.db, 'a');
    b = await createTenantFixture(t.db, 'b');
    relayClient = new pg.Client({ connectionString: t.relayUrl });
    await relayClient.connect();
  });

  afterAll(async () => {
    await relayClient?.end();
    await t?.cleanup();
  });

  describe('emit', () => {
    it('writes the event in the caller transaction: rolled back → gone, committed → there', async () => {
      const rolledBack = await t.db
        .withSystemJob({ orgId: a.orgId }, async (tx) => {
          const event = await emit(tx, joined(a.orgId, a.users.member));
          throw Object.assign(new Error('rollback'), { eventId: event.id });
        })
        .catch((err: { eventId: string }) => err.eventId);
      const committed = await t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
        emit(tx, joined(a.orgId, a.users.member)),
      );

      expect(await outboxIds(t.ownerUrl, [rolledBack, committed.id])).toEqual([committed.id]);
      const { rows } = await query(
        t.ownerUrl,
        'SELECT org_id, topic, type, aggregate_id, payload, published_at FROM saras.outbox_events WHERE id = $1',
        [committed.id],
      );
      expect(rows[0]).toEqual({
        org_id: a.orgId,
        topic: 'member',
        type: 'member.joined',
        aggregate_id: a.users.member,
        payload: {
          actor: committed.actor,
          time: committed.time,
          trace_id: null,
          schema_version: 1,
          data: committed.data,
        },
        published_at: null,
      });
    });

    it('works in a member tenant context too', async () => {
      const event = await t.db.withProjectMember(
        { projectId: a.projectId, userId: a.users.owner },
        (tx) => emit(tx, joined(a.orgId, a.users.owner)),
      );
      expect(await outboxIds(t.ownerUrl, [event.id])).toEqual([event.id]);
    });

    it('rejects an org_id that is not the transaction tenant, and writes nothing', async () => {
      const inOtherOrg = (tx: Tx) => emit(tx, joined(b.orgId, b.users.owner));
      expect(await code(t.db.withSystemJob({ orgId: a.orgId }, inOtherOrg))).toBe(
        'OUTBOX_TENANT_MISMATCH',
      );
      expect(await code(t.db.withUser({ userId: b.users.owner }, inOtherOrg))).toBe(
        'OUTBOX_TENANT_MISMATCH',
      );
      const { rows } = await query<{ n: number }>(
        t.ownerUrl,
        `SELECT count(*)::int AS n FROM saras.outbox_events WHERE org_id = $1 AND type = 'member.joined'`,
        [b.orgId],
      );
      expect(rows[0]!.n).toBe(0);
      expect(new OutboxTenantMismatchError().code).toBe('OUTBOX_TENANT_MISMATCH');
    });

    it('rejects content-carrying events before touching the database', async () => {
      const bad = {
        ...joined(a.orgId, a.users.owner),
        data: { user_id: a.users.owner, note: 'x' },
      };
      expect(
        await code(
          t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
            emit(tx, bad as unknown as NewDomainEvent<'member.joined'>),
          ),
        ),
      ).toBe('INVALID_EVENT');
    });
  });

  describe('relay role', () => {
    it('passes its own startup check; the owner and the app login do not', async () => {
      await expect(t.relay!.assertRelayRole()).resolves.toBeUndefined();
      for (const url of [t.ownerUrl, t.appUrl]) {
        const other = createRelayDatabase({ connectionString: url });
        try {
          await expect(other.assertRelayRole()).rejects.toThrow(/Unsafe relay database role/);
        } finally {
          await other.destroy();
        }
      }
    });

    it('the app role cannot pass for the relay, nor the relay for the app', async () => {
      const { rows } = await query<{ relay_is_app: boolean; app_is_relay: boolean }>(
        t.ownerUrl,
        `SELECT pg_has_role($1, 'saras_app', 'MEMBER') AS relay_is_app,
                pg_has_role($2, 'saras_relay', 'MEMBER') AS app_is_relay`,
        [new URL(t.relayUrl!).username, new URL(t.appUrl).username],
      );
      expect(rows[0]).toEqual({ relay_is_app: false, app_is_relay: false });
    });

    it('sees outbox rows of every org', async () => {
      const { rows } = await relayClient.query<{ org_id: string }>(
        'SELECT DISTINCT org_id FROM saras.outbox_events WHERE org_id = ANY($1)',
        [[a.orgId, b.orgId]],
      );
      expect(rows.map((r) => r.org_id).sort()).toEqual([a.orgId, b.orgId].sort());
    });

    it.each(['messages', 'projects', 'users', 'private_sessions', 'artifacts', 'idempotency_keys'])(
      'is denied SELECT on %s',
      async (table) => {
        expect(await code(relayClient.query(`SELECT 1 FROM saras.${table} LIMIT 1`))).toBe('42501');
      },
    );

    it('cannot read idempotency records through a DELETE … WHERE or RETURNING', async () => {
      expect(
        await code(relayClient.query(`DELETE FROM saras.idempotency_keys WHERE key = 'k'`)),
      ).toBe('42501');
      expect(
        await code(relayClient.query('DELETE FROM saras.idempotency_keys RETURNING response_body')),
      ).toBe('42501');
    });

    it('can change published_at only, only once, and cannot insert', async () => {
      const event = await t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
        emit(tx, joined(a.orgId, a.users.observer)),
      );
      const id = pg.escapeLiteral(event.id);
      for (const column of ['org_id', 'topic', 'type', 'aggregate_id', 'payload', 'created_at']) {
        expect(
          await code(
            relayClient.query(
              `UPDATE saras.outbox_events SET ${column} = ${column} WHERE id = ${id}`,
            ),
          ),
          column,
        ).toBe('42501');
      }
      expect(
        await code(
          relayClient.query(
            `INSERT INTO saras.outbox_events (org_id, topic, type, aggregate_id, payload)
             VALUES ('${a.orgId}', 'member', 'member.joined', '${a.orgId}', '{}')`,
          ),
        ),
      ).toBe('42501');

      // Publish (allowed), then try to un-publish or re-publish (policy: only from NULL).
      const publish = await relayClient.query(
        `UPDATE saras.outbox_events SET published_at = now() WHERE id = ${id}`,
      );
      expect(publish.rowCount).toBe(1);
      // A published row fails relay_publish's USING clause, so both UPDATEs match nothing.
      const unpublish = await relayClient.query(
        `UPDATE saras.outbox_events SET published_at = NULL WHERE id = ${id}`,
      );
      const republish = await relayClient.query(
        `UPDATE saras.outbox_events SET published_at = now() WHERE id = ${id}`,
      );
      expect([unpublish.rowCount, republish.rowCount]).toEqual([0, 0]);
      const { rows } = await query<{ published: boolean }>(
        t.ownerUrl,
        'SELECT published_at IS NOT NULL AS published FROM saras.outbox_events WHERE id = $1',
        [event.id],
      );
      expect(rows[0]!.published).toBe(true);
    });

    it('cannot delete recent or unpublished outbox rows', async () => {
      const event = await t.db.withSystemJob({ orgId: a.orgId }, (tx) =>
        emit(tx, joined(a.orgId, a.users.outsider)),
      );
      const deleted = await relayClient.query('DELETE FROM saras.outbox_events WHERE id = $1', [
        event.id,
      ]);
      expect(deleted.rowCount).toBe(0);
      expect(await outboxIds(t.ownerUrl, [event.id])).toEqual([event.id]);
    });

    it('has privileges on outbox_events and idempotency_keys only in saras, and DML in pgboss', async () => {
      const { rows } = await query<{ relname: string; privs: string[] }>(
        t.ownerUrl,
        `SELECT c.relname, array_agg(p.priv ORDER BY p.priv) AS privs
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(priv)
         WHERE n.nspname = 'saras' AND c.relkind IN ('r','p','v')
           AND (has_table_privilege('saras_relay', c.oid, p.priv)
                OR (p.priv = 'UPDATE' AND has_any_column_privilege('saras_relay', c.oid, 'UPDATE')))
         GROUP BY c.relname ORDER BY 1`,
      );
      expect(rows).toEqual([
        { relname: 'idempotency_keys', privs: ['DELETE'] },
        { relname: 'outbox_events', privs: ['DELETE', 'SELECT', 'UPDATE'] },
      ]);
      const cols = await query<{ attname: string }>(
        t.ownerUrl,
        `SELECT attname FROM pg_attribute
         WHERE attrelid = 'saras.outbox_events'::regclass AND attnum > 0 AND NOT attisdropped
           AND has_column_privilege('saras_relay', attrelid, attnum, 'UPDATE') ORDER BY 1`,
      );
      expect(cols.rows.map((r) => r.attname)).toEqual(['published_at']);

      const boss = await query<{ app_usage: boolean; relay_usage: boolean; job_dml: boolean }>(
        t.ownerUrl,
        `SELECT has_schema_privilege('saras_app', 'pgboss', 'USAGE') AS app_usage,
                has_schema_privilege('saras_relay', 'pgboss', 'USAGE') AS relay_usage,
                has_table_privilege('saras_relay', 'pgboss.job', 'SELECT, INSERT, UPDATE, DELETE') AS job_dml`,
      );
      expect(boss.rows[0]).toEqual({ app_usage: false, relay_usage: true, job_dml: true });

      const attrs = await query<{ unsafe: boolean; login: boolean }>(
        t.ownerUrl,
        `SELECT rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb AS unsafe, rolcanlogin AS login
         FROM pg_roles WHERE rolname = 'saras_relay'`,
      );
      expect(attrs.rows[0]).toEqual({ unsafe: false, login: false });
    });
  });

  describe('app role', () => {
    it('still sees only its own org outbox rows', async () => {
      const seen = await t.db.withTenant({ orgId: a.orgId, userId: a.users.owner }, async (tx) => {
        const { rows } = await sql<{ own: number; other: number }>`
          SELECT count(*) FILTER (WHERE org_id = ${a.orgId})::int AS own,
                 count(*) FILTER (WHERE org_id <> ${a.orgId})::int AS other
          FROM outbox_events`.execute(tx);
        return rows[0]!;
      });
      expect(seen.own).toBeGreaterThan(0);
      expect(seen.other).toBe(0);
    });
  });

  describe('housekeeping', () => {
    it('the 7-day cleanup deletes only rows published more than 7 days ago', async () => {
      const [old, recent, unpublished] = [uuidv7(), uuidv7(), uuidv7()];
      await query(
        t.ownerUrl,
        `INSERT INTO saras.outbox_events (id, org_id, topic, type, aggregate_id, payload, created_at, published_at)
         VALUES ($1, $4, 'member', 'member.joined', $4, '{}', now() - interval '9 days', now() - interval '8 days'),
                ($2, $4, 'member', 'member.joined', $4, '{}', now() - interval '2 days', now() - interval '1 day'),
                ($3, $4, 'member', 'member.joined', $4, '{}', now() - interval '30 days', NULL)`,
        [old, recent, unpublished, a.orgId],
      );
      expect(await t.relay!.deletePublishedOutbox()).toBeGreaterThanOrEqual(1);
      expect((await outboxIds(t.ownerUrl, [old, recent, unpublished])).sort()).toEqual(
        [recent, unpublished].sort(),
      );
    });

    it('the idempotency sweep deletes only expired records', async () => {
      const [expired, live] = [`k-${randomUUID()}`, `k-${randomUUID()}`];
      await query(
        t.ownerUrl,
        `INSERT INTO saras.idempotency_keys (user_id, key, method, path, request_hash, response_status, expires_at)
         VALUES ($1, $2, 'POST', '/v1/x', 'h', 201, now() - interval '1 minute'),
                ($1, $3, 'POST', '/v1/x', 'h', 201, now() + interval '1 day')`,
        [a.users.owner, expired, live],
      );
      expect(await t.relay!.sweepExpiredIdempotencyKeys()).toBeGreaterThanOrEqual(1);
      const { rows } = await query<{ key: string }>(
        t.ownerUrl,
        'SELECT key FROM saras.idempotency_keys WHERE key = ANY($1)',
        [[expired, live]],
      );
      expect(rows.map((r) => r.key)).toEqual([live]);
    });
  });
});
