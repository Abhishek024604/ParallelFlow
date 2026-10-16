import { randomUUID } from 'node:crypto';
import { uuidv7, InvalidEventError } from '@saras/contracts';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { outboxRecordToEvent } from './outbox.js';
import { claimBatchQuery } from './relay.js';
import { assertDirectUrl, assertRelayUrl } from './roles.js';

const compiler = new Kysely<unknown>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe('claimBatchQuery', () => {
  it('claims the oldest unpublished rows and skips rows another relay holds', () => {
    const { sql, parameters } = claimBatchQuery(50).compile(compiler);
    const flat = sql.replace(/\s+/g, ' ').trim();
    expect(flat).toContain('FROM saras.outbox_events WHERE published_at IS NULL');
    expect(flat).toContain('ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED');
    expect(parameters).toEqual([50]);
  });

  it.each([0, -1, 1.5, 1001])('rejects batch size %s', (n) => {
    expect(() => claimBatchQuery(n)).toThrow();
  });
});

describe('outboxRecordToEvent', () => {
  const org = randomUUID();
  const user = randomUUID();
  const id = uuidv7();
  const payload = {
    actor: { type: 'system', id: null, on_behalf_of: null },
    time: new Date().toISOString(),
    trace_id: null,
    schema_version: 1,
    data: { user_id: user, invitation_id: null, project_id: null },
  };
  const record = {
    id,
    org_id: org,
    topic: 'member',
    type: 'member.joined',
    aggregate_id: user,
    payload,
    created_at: new Date(),
  };

  it('maps the columns back onto the doc 07 envelope', () => {
    expect(outboxRecordToEvent(record)).toEqual({
      id,
      type: 'member.joined',
      org_id: org,
      subject: user,
      ...payload,
    });
  });

  it('rejects rows not written by emit', () => {
    expect(() => outboxRecordToEvent({ ...record, payload: {} })).toThrow(InvalidEventError);
    expect(() => outboxRecordToEvent({ ...record, type: 'project.created' })).toThrow(
      InvalidEventError,
    );
    expect(() =>
      outboxRecordToEvent({ ...record, payload: { ...payload, data: { body: 'text' } } }),
    ).toThrow(InvalidEventError);
  });
});

describe('relay URL checks', () => {
  const owner = 'postgres://neondb_owner:owner-pw@ep-x.example.com/saras';
  const app = 'postgres://saras_api:app-pw@ep-x-pooler.example.com/saras';
  const relay = 'postgres://saras_relay_login:relay-pw@ep-x.example.com/saras';

  it('accepts a direct URL with its own user', () => {
    expect(() => assertRelayUrl(relay, owner, app)).not.toThrow();
  });

  it.each([
    ['a pooled Neon host', 'postgres://r:pw@ep-x-pooler.example.com/saras', /direct/],
    ['PgBouncer port', 'postgres://r:pw@db.example.com:6432/saras', /direct/],
    ['not postgres', 'https://r:pw@example.com', /postgres:\/\//],
    ['no password', 'postgres://r@ep-x.example.com/saras', /user and password/],
    [
      'the owner user',
      'postgres://neondb_owner:pw@ep-x.example.com/saras',
      /MIGRATION_DATABASE_URL/,
    ],
    ['the app user', 'postgres://saras_api:pw@ep-x.example.com/saras', /than DATABASE_URL/],
  ])('rejects %s without echoing the URL', (_label, url, message) => {
    let error: Error | undefined;
    try {
      assertRelayUrl(url, owner, app);
    } catch (err) {
      error = err as Error;
    }
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain('pw@');
  });

  it('assertDirectUrl names the variable', () => {
    expect(() => assertDirectUrl('not a url', 'X_URL')).toThrow(/X_URL/);
  });
});
