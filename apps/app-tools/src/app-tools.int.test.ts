import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  createTenantFixture,
  createTestDatabase,
  integrationEnabled,
  query,
  type TenantFixture,
  type TestDatabase,
} from '@parallelflow/db/testing';
import { createLogger } from '@parallelflow/observability';
import { mintToolToken, type ToolTokenInput } from '@parallelflow/runtime-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadContract } from './contract.js';
import { DbToolBackend } from './db.js';
import { createAppToolsHandler } from './server.js';
import { NIL_UUID } from './token.js';

// App Tools smoke test (ADR-035) against a real database (RLS on) over real MCP Streamable HTTP:
// a central token reads its own arena's history and gets SCOPE_MISMATCH for another arena's
// artifact; a personal token for user A never sees user B's private chats.

const enabled = await integrationEnabled();
const KEY = 't'.repeat(48);
const CENTRAL_SCOPES = [
  'arena.read_history',
  'artifacts.read',
  'knowledge.search',
  'members.list',
  'project.get_overview',
];

describe.skipIf(!enabled)('app tools', () => {
  let t: TestDatabase;
  let a: TenantFixture;
  let b: TenantFixture;
  let server: Server;
  let url: string;
  let otherArtifactId: string;
  const userA = randomUUID();
  const userB = randomUUID();
  const chatA = randomUUID();
  const chatB = randomUUID();

  const centralToken = (f: TenantFixture): ToolTokenInput => ({
    sessionKey: `org/${f.orgId}/project/${f.projectId}/arena`,
    orgId: f.orgId,
    projectId: f.projectId,
    principal: { type: 'agent', id: randomUUID(), kind: 'central' },
    scopes: CENTRAL_SCOPES,
  });
  const personalToken = (userId: string, chat: string): ToolTokenInput => ({
    sessionKey: `org/${NIL_UUID}/user/${userId}/private/${chat}`,
    orgId: NIL_UUID,
    projectId: null,
    principal: { type: 'agent', id: randomUUID(), kind: 'personal', on_behalf_of: userId },
    scopes: ['knowledge.search', 'private.save_artifact'],
  });

  async function connect(input: ToolTokenInput): Promise<Client> {
    const token = mintToolToken(input, KEY, url).token;
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    return client;
  }

  beforeAll(async () => {
    t = await createTestDatabase();
    a = await createTenantFixture(t.db, 'tools-a');
    b = await createTenantFixture(t.db, 'tools-b');
    const own = t.ownerUrl;
    await query(
      own,
      `INSERT INTO messages (org_id, arena_id, author_type, author_id, body)
       VALUES ($1, $2, 'user', $3, 'canary-arena-a-message')`,
      [a.orgId, a.arenaId, a.users.owner],
    );
    const { rows } = await query<{ id: string }>(
      own,
      `INSERT INTO artifacts (org_id, project_id, scope, kind, name, lineage_id, created_by, created_by_type)
       VALUES ($1, $2, 'project', 'spec', 'B spec', gen_random_uuid(), $3, 'user') RETURNING id`,
      [b.orgId, b.projectId, b.users.owner],
    );
    otherArtifactId = rows[0]!.id;
    for (const [user, chat, canary] of [
      [userA, chatA, 'canary-private-a'],
      [userB, chatB, 'canary-private-b'],
    ] as const) {
      await query(
        own,
        `INSERT INTO users (id, email, handle, display_name) VALUES ($1, $2, $3, $3)`,
        [user, `${user}@example.test`, `u${user.slice(0, 8)}`],
      );
      await query(own, `INSERT INTO private_sessions (id, owner_user_id) VALUES ($1, $2)`, [
        chat,
        user,
      ]);
      await query(
        own,
        `INSERT INTO messages (private_session_id, author_type, author_id, body)
         VALUES ($1, 'user', $2, $3)`,
        [chat, user, canary],
      );
    }

    const handler = createAppToolsHandler({
      contract: loadContract(),
      backend: new DbToolBackend(t.db),
      toolTokenKey: KEY,
      logger: createLogger({ name: 'app-tools-test', level: 'silent' }),
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await t?.cleanup();
  });

  it('central token reads its own arena history', async () => {
    const client = await connect(centralToken(a));
    const result = await client.callTool({ name: 'arena.read_history', arguments: {} });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.structuredContent)).toContain('canary-arena-a-message');
    await client.close();
  });

  it('central token gets SCOPE_MISMATCH for another arena', async () => {
    const client = await connect(centralToken(a));
    const result = await client.callTool({
      name: 'artifacts.read',
      arguments: { artifact_id: otherArtifactId },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: 'SCOPE_MISMATCH' } });
    await client.close();
  });

  it("a personal token for user A cannot read user B's private chats", async () => {
    const client = await connect(personalToken(userA, chatA));
    const mine = await client.callTool({
      name: 'knowledge.search',
      arguments: { query: 'canary-private-a' },
    });
    expect(JSON.stringify(mine.structuredContent)).toContain('canary-private-a');
    const theirs = await client.callTool({
      name: 'knowledge.search',
      arguments: { query: 'canary-private-b' },
    });
    expect(JSON.stringify(theirs.structuredContent)).not.toContain('canary-private-b');
    const tools = await client.listTools();
    expect(tools.tools.map((x) => x.name).sort()).toEqual([
      'knowledge.search',
      'private.save_artifact',
    ]);
    await client.close();
  });

  it('refuses a request without a valid token', async () => {
    const res = await fetch(url, { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });
});
