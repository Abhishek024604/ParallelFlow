import { randomUUID } from 'node:crypto';
import type { Database, DB } from '@parallelflow/db';
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from 'kysely';
import { describe, expect, it } from 'vitest';
import { DbToolBackend } from './db.js';
import { NIL_UUID, type ToolPrincipal } from './token.js';

// memory.recall from a linked private chat (unbound token), without a database: a scripted driver
// answers each statement by its SQL, so the test sees which arena every graph read is filtered by.

interface Script {
  /** private_sessions.bound_project_id of the chat (null: not linked). */
  link: string | null;
  /** The user's active membership of that arena (enterProjectMember). */
  member: boolean;
  /** The user holds arena.read there. */
  canRead: boolean;
}

function scriptedDb(script: Script) {
  const seen: { sql: string; params: readonly unknown[] }[] = [];
  const scopes: string[] = [];
  const answer = (q: CompiledQuery): QueryResult<unknown> => {
    seen.push({ sql: q.sql, params: q.parameters });
    const s = q.sql;
    if (s.includes('"private_sessions"')) {
      return { rows: [{ bound_project_id: script.link }] };
    }
    if (s.includes("set_config('app.org_id'")) {
      return { rows: script.member ? [{ org_id: randomUUID() }] : [] };
    }
    if (s.includes('"member_capabilities"')) {
      return { rows: script.canRead ? [{ capability: 'arena.read' }] : [] };
    }
    if (s.includes('FROM kg_nodes n')) {
      return {
        rows: [
          {
            id: randomUUID(),
            type: 'Decision',
            key: 'D-001',
            title: 'Use Postgres',
            summary: 's',
            status: 'active',
            attrs: {},
            first_seen: '2026-11-01',
            last_seen: '2026-11-02',
          },
        ],
      };
    }
    return { rows: [] };
  };
  const connection: DatabaseConnection = {
    executeQuery: async <R>(q: CompiledQuery) => answer(q) as QueryResult<R>,
    streamQuery: () => {
      throw new Error('not used');
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  const kysely = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const db = {
    withUser: (_ctx: { userId: string }, fn: (tx: unknown) => Promise<unknown>) => {
      scopes.push('user');
      return kysely.transaction().execute(fn);
    },
    withSystemJob: (_ctx: { orgId: string }, fn: (tx: unknown) => Promise<unknown>) => {
      scopes.push('system');
      return kysely.transaction().execute(fn);
    },
  } as unknown as Database;
  /** Every project id a memory-graph read was filtered by. */
  const graphProjects = () =>
    seen
      .filter((q) => /\bkg_(nodes|edges|sources)\b/.test(q.sql))
      .flatMap((q) => q.params.filter((v) => typeof v === 'string' && v.length === 36));
  return { backend: new DbToolBackend(db), seen, scopes, graphProjects };
}

const user = randomUUID();
const chat = randomUUID();
const linkedChat: ToolPrincipal = {
  sessionKey: `org/${NIL_UUID}/user/${user}/private/${chat}`,
  orgId: NIL_UUID,
  projectId: null,
  agentId: randomUUID(),
  kind: 'personal',
  onBehalfOf: user,
  scopes: new Set(['memory.recall']),
  isPrivate: true,
  privateSessionId: chat,
};

describe('memory.recall from a linked private chat', () => {
  it("reads only the linked arena's memory, after membership and arena.read", async () => {
    const arena = randomUUID();
    const { backend, seen, scopes, graphProjects } = scriptedDb({
      link: arena,
      member: true,
      canRead: true,
    });
    const result = await backend.recall(linkedChat, { query: 'D-001' });
    expect(result).toEqual([expect.objectContaining({ key: 'D-001', title: 'Use Postgres' })]);
    // One user-scope transaction: link, then the verified membership, then arena.read, then reads.
    expect(scopes).toEqual(['user']);
    const order = seen.map((q) =>
      q.sql.includes('"private_sessions"')
        ? 'link'
        : q.sql.includes("set_config('app.org_id'")
          ? 'member'
          : q.sql.includes('"member_capabilities"')
            ? 'can_read'
            : q.sql.includes('kg_nodes n')
              ? 'nodes'
              : 'other',
    );
    expect(order.slice(0, 4)).toEqual(['link', 'member', 'can_read', 'nodes']);
    const link = seen.find((q) => q.sql.includes('"private_sessions"'));
    expect(link?.params).toEqual(expect.arrayContaining([chat, user]));
    expect(new Set(graphProjects())).toEqual(new Set([arena]));
  });

  it('answers not_available when the chat is not linked, and reads no memory', async () => {
    const { backend, graphProjects } = scriptedDb({ link: null, member: true, canRead: true });
    expect(await backend.recall(linkedChat, { query: 'D-001' })).toEqual({
      status: 'not_available',
      reason: 'This chat is not linked to an arena.',
    });
    expect(graphProjects()).toEqual([]);
  });

  it('answers not_available when the user is not a member of the linked arena', async () => {
    const { backend, graphProjects } = scriptedDb({
      link: randomUUID(),
      member: false,
      canRead: true,
    });
    expect(await backend.recall(linkedChat, { query: 'D-001' })).toEqual({
      status: 'not_available',
      reason: 'You are no longer a member of the linked arena.',
    });
    expect(graphProjects()).toEqual([]);
  });

  it('answers not_available without arena.read', async () => {
    const { backend, graphProjects } = scriptedDb({
      link: randomUUID(),
      member: true,
      canRead: false,
    });
    expect(await backend.recall(linkedChat, { query: 'D-001' })).toEqual({
      status: 'not_available',
      reason: 'You cannot read the linked arena.',
    });
    expect(graphProjects()).toEqual([]);
  });

  it("keeps the central agent on its token's arena, without reading any chat link", async () => {
    const project = randomUUID();
    const { backend, seen, scopes, graphProjects } = scriptedDb({
      link: randomUUID(),
      member: true,
      canRead: true,
    });
    const central: ToolPrincipal = {
      ...linkedChat,
      sessionKey: `org/${randomUUID()}/project/${project}/arena`,
      orgId: randomUUID(),
      projectId: project,
      kind: 'central',
      onBehalfOf: null,
      isPrivate: false,
      privateSessionId: null,
    };
    expect(await backend.recall(central, { query: 'D-001' })).toHaveLength(1);
    expect(scopes).toEqual(['system']);
    expect(seen.some((q) => q.sql.includes('"private_sessions"'))).toBe(false);
    expect(new Set(graphProjects())).toEqual(new Set([project]));
  });
});
