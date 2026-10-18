// The codebase-intelligence MCP server Pi connects to (Streamable HTTP on 127.0.0.1, a random port,
// a random bearer token per agent start; stateless: one MCP server per request). Localhost HTTP is
// used rather than stdio because the tools need the running VS Code (language servers,
// diagnostics), which a stdio child of Pi could not reach.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, type IntelBackend, TOOLS } from './tools.js';

export interface RunningMcpServer {
  url: string;
  token: string;
  close(): Promise<void>;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function mcpFor(backend: IntelBackend): Server {
  const server = new Server(
    { name: 'saras-ide', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as { type: 'object' },
      annotations: t.annotations,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(request.params.name, request.params.arguments, backend);
    return { content: [{ type: 'text', text: result.text }], isError: result.isError };
  });
  return server;
}

export async function startMcpServer(backend: IntelBackend): Promise<RunningMcpServer> {
  const token = randomBytes(32).toString('base64url');
  const httpServer = http.createServer(async (req, res) => {
    const send = (status: number, message: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: message }));
    };
    // Only loopback Host headers (DNS rebinding) and only our bearer token.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (host !== '127.0.0.1' && host !== 'localhost') return send(403, 'Forbidden');
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/mcp')
      return send(404, 'Not found');
    if (!tokenMatches(req.headers.authorization, token)) return send(401, 'Unauthorized');
    const server = mcpFor(backend);
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
      if (!res.headersSent) send(500, 'Request failed');
    }
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections?.();
        httpServer.close(() => resolve());
      }),
  };
}
