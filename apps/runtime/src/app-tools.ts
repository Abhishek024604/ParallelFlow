import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolToken } from '@parallelflow/runtime-client';
import { type AgentTool, ToolCallError } from './agent.js';
import { buildDiagram, isDrawioName } from './diagram-layout.js';
import { DiagramSpecError } from './diagram-spec.js';
import { modelToolName } from './profiles.js';

// The runtime's App Tools client (ADR-035). Pi 1.x has MCP only as a CLI extension, so each App Tool
// is wrapped as a Pi custom tool that calls the App Tools MCP server with the MCP SDK client. Each
// session has its own client and presents its own ToolToken (rule 3); the token is read at call time
// so a rotation (PUT /token, bind) takes effect at once. The current turn id goes in x-parallelflow-turn-id
// for the audit row. Tokens, arguments and results are never logged.

export const TURN_HEADER = 'x-parallelflow-turn-id';

/** Draft tools: an accepted call becomes the RIC artifact.proposed event (one storage path). */
const DRAFT_TOOLS = new Set(['artifacts.create_draft', 'private.save_artifact']);
/** An accepted ask.question becomes the RIC question.asked event (the app shows a question card). */
const QUESTION_TOOL = 'ask.question';

export interface QuestionProposal {
  question: string;
  options: string[];
  allow_other: boolean;
}

const ARTIFACT_KINDS = new Set([
  'goal',
  'spec',
  'plan',
  'test_report',
  'release_notes',
  'document',
  'diagram',
  'other',
]);

export interface ArtifactProposal {
  name: string;
  kind: string;
  content: string;
  content_type: string;
}

export interface ToolSessionContext {
  /** The session's current token, or undefined (no tools). */
  token(): ToolToken | undefined;
  /** The running turn, for the audit header. */
  turnId(): string | null;
  /** An accepted draft: the service emits artifact.proposed on the running turn. */
  onArtifact(proposal: ArtifactProposal): void;
  /** An accepted question: the service emits question.asked on the running turn. */
  onQuestion?(question: QuestionProposal): void;
}

export interface ToolSet {
  tools: AgentTool[];
  /** Model-facing name → App Tools name. */
  names: Map<string, string>;
  close(): Promise<void>;
}

export interface ToolSource {
  /** Model-facing tools for this session (exactly what App Tools lists for its token). */
  tools(ctx: ToolSessionContext): Promise<ToolSet>;
}

interface McpResult {
  isError?: boolean;
  content?: unknown;
  structuredContent?: unknown;
}

function textOf(result: McpResult): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .map((part) => part as { type?: string; text?: string })
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/** App Tools over MCP Streamable HTTP. */
export class McpToolSource implements ToolSource {
  constructor(private readonly timeoutMs = 30_000) {}

  private async connect(ctx: ToolSessionContext): Promise<Client> {
    const token = ctx.token();
    if (!token) throw new Error('No tool token');
    // Headers are added per request, so the newest token and turn id are always used.
    const authFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      const current = ctx.token();
      if (current) headers.set('authorization', `Bearer ${current.token}`);
      const turn = ctx.turnId();
      if (turn) headers.set(TURN_HEADER, turn);
      else headers.delete(TURN_HEADER);
      return fetch(input, { ...init, headers });
    };
    const client = new Client({ name: 'parallelflow-runtime', version: '0.2.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(token.mcp_url), { fetch: authFetch }),
    );
    return client;
  }

  async tools(ctx: ToolSessionContext): Promise<ToolSet> {
    let client = await this.connect(ctx);
    const listed = await client.listTools(undefined, { timeout: this.timeoutMs });
    const names = new Map<string, string>();

    const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
      try {
        return (await client.callTool({ name, arguments: args }, undefined, {
          timeout: this.timeoutMs,
          ...(signal && { signal }),
        })) as McpResult;
      } catch (err) {
        if (signal?.aborted) throw err;
        // One reconnect (App Tools restarted, token's mcp_url changed), then give up.
        await client.close().catch(() => undefined);
        client = await this.connect(ctx);
        return (await client.callTool({ name, arguments: args }, undefined, {
          timeout: this.timeoutMs,
        })) as McpResult;
      }
    };

    const tools = listed.tools.map((tool): AgentTool => {
      const modelName = modelToolName(tool.name);
      names.set(modelName, tool.name);
      return {
        name: modelName,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema as Record<string, unknown>,
        execute: async (input, signal) => {
          let args = input;
          let note = '';
          // A .drawio draft is built (from a spec) and laid out before it is saved.
          if (DRAFT_TOOLS.has(tool.name) && isDrawioName(String(args['name'] ?? ''))) {
            let built;
            try {
              built = await buildDiagram(String(args['content'] ?? ''), args['layout']);
            } catch (err) {
              if (err instanceof DiagramSpecError)
                throw new ToolCallError('INVALID_ARGS', err.message);
              throw err;
            }
            args = { ...args, content: built.xml };
            if (built.layout !== 'none' && !built.laidOut) {
              note =
                '\nNote: the automatic layout could not run; the diagram was saved as written.';
            }
          }
          let result: McpResult;
          try {
            result = await call(tool.name, args, signal);
          } catch {
            throw new ToolCallError(
              'UNAVAILABLE',
              'The workspace tools did not answer. Try again later.',
            );
          }
          const text = textOf(result);
          if (result.isError) {
            const code = /^([A-Z][A-Z_]{2,40})\b/.exec(text)?.[1] ?? 'ERROR';
            throw new ToolCallError(code, text || code);
          }
          const data = (result.structuredContent ?? {}) as Record<string, unknown>;
          if (DRAFT_TOOLS.has(tool.name) && data['delivery'] === 'artifact.proposed') {
            const kind = String(args['kind'] ?? 'document');
            ctx.onArtifact({
              name: String(data['name'] ?? args['name'] ?? 'Draft'),
              kind: ARTIFACT_KINDS.has(kind) ? kind : 'document',
              content: String(args['content'] ?? ''),
              content_type: 'text/markdown',
            });
          }
          if (tool.name === QUESTION_TOOL && data['delivery'] === 'question.asked') {
            const options = Array.isArray(data['options']) ? data['options'].map(String) : [];
            ctx.onQuestion?.({
              question: String(data['question'] ?? ''),
              options,
              allow_other: data['allow_other'] === true,
            });
          }
          return (text || JSON.stringify(data)) + note;
        },
      };
    });
    return { tools, names, close: () => client.close() };
  }
}
