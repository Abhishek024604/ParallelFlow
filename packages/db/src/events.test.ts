import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import type { Tx } from './database.js';
import { cleanMetadata, recordArenaEvent, setArenaEventListener } from './events.js';
import type { DB } from './schema.gen.js';

// The event writer without a database: the SQL it sends, the metadata it keeps, the listener.

function capturing() {
  const queries: { sql: string; parameters: readonly unknown[] }[] = [];
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log: (e) => {
      if (e.level === 'query') queries.push(e.query);
    },
  });
  return { tx: db as unknown as Tx, queries };
}

const scope = { orgId: 'org-1', projectId: 'proj-1' };

afterEach(() => setArenaEventListener(null));

describe('arena events', () => {
  it('keeps flat, short metadata only', () => {
    expect(cleanMetadata({ name: '  a\n b  ', n: 2, gone: undefined, ok: true, x: null })).toEqual({
      name: 'a b',
      n: 2,
      ok: true,
      x: null,
    });
    expect(String(cleanMetadata({ title: 'x'.repeat(500) }).title)).toHaveLength(200);
    expect(cleanMetadata({ stages: ['PLAN', 'DESIGN'] })).toEqual({ stages: ['PLAN', 'DESIGN'] });
    // A nested object could carry a document: refused.
    expect(() => cleanMetadata({ doc: { body: 'secret' } } as never)).toThrow(/flat/);
    expect(() => cleanMetadata({ list: [{ body: 'secret' }] } as never)).toThrow(/flat/);
  });

  it('inserts one row in the caller transaction; the database sets id and hashes', async () => {
    const { tx, queries } = capturing();
    await recordArenaEvent(
      tx,
      scope,
      { type: 'user', id: 'user-1' },
      {
        action: 'file.uploaded',
        target: { type: 'file', id: 'file-1' },
        metadata: { name: 'spec.pdf', size_bytes: 10 },
      },
    );
    expect(queries).toHaveLength(1);
    const q = queries[0]!;
    expect(q.sql).toMatch(/INSERT INTO audit_events/);
    expect(q.sql).not.toMatch(/RETURNING/i);
    expect(q.sql).not.toMatch(/prev_hash/);
    expect(q.parameters).toContain('org-1');
    expect(q.parameters).toContain('proj-1');
    expect(q.parameters).toContain('file.uploaded');
    expect(q.parameters).toContain(JSON.stringify({ name: 'spec.pdf', size_bytes: 10 }));
  });

  it('names a service actor by label (nil actor id) and tells the listener', async () => {
    const { tx, queries } = capturing();
    const told: unknown[] = [];
    setArenaEventListener((s) => told.push(s));
    await recordArenaEvent(
      tx,
      scope,
      { type: 'service', label: 'GitHub · ravi' },
      {
        action: 'repo.commit.pushed',
        target: { type: 'branch', id: 'main' },
        metadata: { count: 2 },
      },
    );
    const params = queries[0]!.parameters;
    expect(params).toContain('00000000-0000-0000-0000-000000000000');
    expect(params).toContain(JSON.stringify({ count: 2, actor_label: 'GitHub · ravi' }));
    expect(told).toEqual([scope]);
  });

  it('a failing listener never fails the change', async () => {
    const { tx } = capturing();
    setArenaEventListener(() => {
      throw new Error('boom');
    });
    await expect(
      recordArenaEvent(
        tx,
        scope,
        { type: 'agent', id: 'agent-1' },
        {
          action: 'ai.file.drafted',
          target: { type: 'file', id: 'f' },
        },
      ),
    ).resolves.toBeUndefined();
  });
});
