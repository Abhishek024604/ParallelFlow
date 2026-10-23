import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '@parallelflow/observability';
import type { AppToolsContract, ToolSpec } from './contract.js';
import { assertNoHumanOnly, listableTools } from './policy.js';
import { type ToolPrincipal, ToolTokenError, verifyToolToken } from './token.js';
import { executeTool, InvalidToolArgs, type ToolBackend } from './tools.js';

// The App Tools MCP server (Streamable HTTP, stateless: one MCP server per HTTP request). Every
// request carries `Authorization: Bearer <ToolToken>`; the runtime also sends the current turn id in
// `x-parallelflow-turn-id` so the audit row can name the turn. tools/list answers only the tools this token
// may use.

export const TURN_HEADER = 'x-parallelflow-turn-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AppToolsServerOptions {
  contract: AppToolsContract;
  backend: ToolBackend;
  toolTokenKey: string;
  logger: Logger;
  /** Path of the MCP endpoint, default /mcp. */
  path?: string;
  clock?: () => number;
  /** Audit rows off the reply path (ExecuteDeps.auditInBackground). */
  auditInBackground?: boolean;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function principalOf(req: IncomingMessage, key: string, clock: () => number): ToolPrincipal | null {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match?.[1]) return null;
  try {
    return verifyToolToken(match[1], key, Math.floor(clock() / 1000));
  } catch (err) {
    if (err instanceof ToolTokenError) return null;
    throw err;
  }
}

function mcpServer(
  options: AppToolsServerOptions,
  specs: ReadonlyMap<string, ToolSpec>,
  principal: ToolPrincipal,
  turnId: string | null,
): Server {
  const server = new Server(
    { name: options.contract.server.name, version: options.contract.server.version },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: listableTools([...specs.values()], principal).map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema as { type: 'object' },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      return await executeTool(
        {
          specs,
          backend: options.backend,
          logger: options.logger,
          clock: options.clock,
          auditInBackground: options.auditInBackground,
        },
        principal,
        request.params.name,
        request.params.arguments ?? {},
        turnId,
      );
    } catch (err) {
      if (err instanceof InvalidToolArgs) throw new McpError(ErrorCode.InvalidParams, err.message);
      throw new McpError(ErrorCode.InternalError, 'The tool failed');
    }
  });
  return server;
}

/** The node:http request handler for App Tools. */
export function createAppToolsHandler(
  options: AppToolsServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  assertNoHumanOnly(options.contract.tools);
  const specs = new Map(options.contract.tools.map((t) => [t.name, t]));
  const path = options.path ?? '/mcp';
  const clock = options.clock ?? Date.now;

  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://app-tools');
    if (url.pathname === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (url.pathname !== path) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: 'Not found' });
      return;
    }
    const principal = principalOf(req, options.toolTokenKey, clock);
    if (!principal) {
      sendJson(res, 401, { code: 'UNAUTHENTICATED', message: 'A valid tool token is required' });
      return;
    }
    const rawTurn = req.headers[TURN_HEADER];
    const turnId = typeof rawTurn === 'string' && UUID.test(rawTurn) ? rawTurn.toLowerCase() : null;

    const server = mcpServer(options, specs, principal, turnId);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      options.logger.error('app tools: request failed');
      if (!res.headersSent) sendJson(res, 500, { code: 'INTERNAL', message: 'Request failed' });
    }
  };
}
