// saras-guard: the Pi extension that fences the agent to the project folder and routes approvals to
// VS Code. Loaded with `pi -ne -e builtin:mcp -e <this file>`, so it is the only extension besides
// the built-in MCP client. Pi resolves the `typebox` and `@earendil-works/pi-coding-agent` imports
// itself (esbuild keeps them external).
//
// What it does, before any tool runs (Pi's `tool_call` hook, which blocks on our promise):
//   read/ls/find/grep  path must resolve (realpath) inside the folder; patterns may not climb out
//   write/edit         same, `.git` is never writable, config folders ask, others follow autoApproveEdits
//   bash               allowlisted plain commands run; everything else asks in VS Code (default deny)
//   anything else      blocked, except ask_user, saras-agent's load_skill and the folder's codebase MCP tools
// It also registers the Saras model provider (token read once from the environment, then removed so
// shell commands never see it) and replaces the bash tool with one that re-scrubs its environment.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBashToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { scrubEnv } from '../shared/env.js';
import { fencePath } from '../shared/fence.js';
import { decodeQuestionAnswer, encodeRequest, parseGuardConfig } from '../shared/protocol.js';
import { block, createGuard, fenceOptions, MCP_SERVER_NAME } from './policy.js';

const AskParams = Type.Object({
  question: Type.String({ description: 'The question for the person, in one or two sentences' }),
  options: Type.Array(Type.String(), {
    description: 'Two to five short answers to choose from. The person may also type their own.',
  }),
});

export default function sarasGuard(pi: ExtensionAPI): void {
  const config = parseGuardConfig(process.env.SARAS_GUARD_CONFIG);
  const llmToken = process.env.SARAS_LLM_TOKEN ?? '';
  const mcpToken = process.env.SARAS_MCP_TOKEN ?? '';
  // Read once; shell commands and child processes never see these.
  delete process.env.SARAS_LLM_TOKEN;
  delete process.env.SARAS_MCP_TOKEN;
  delete process.env.SARAS_GUARD_CONFIG;

  if (!config) {
    // Fail closed: without a configuration nothing runs.
    pi.on('tool_call', async () => block('Saras guard is not configured'));
    return;
  }

  pi.registerProvider('saras', {
    name: 'Saras',
    baseUrl: config.llm.baseUrl,
    api: 'openai-completions',
    apiKey: llmToken,
    models: config.llm.models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });

  if (config.mcpUrl && mcpToken) {
    pi.registerMcpServer(MCP_SERVER_NAME, {
      url: config.mcpUrl,
      headers: { Authorization: `Bearer ${mcpToken}` },
      exposure: 'direct',
      description:
        'Codebase context from VS Code: file tree, symbols, search, diagnostics, dependencies',
    });
  }

  const fence = fenceOptions(config.root);
  let uiContext: ExtensionContext | undefined;

  const guard = createGuard({
    config,
    fence,
    ask: async (title, options, timeoutMs) => {
      if (!uiContext?.hasUI) return undefined;
      return uiContext.ui.select(title, options, { timeout: timeoutMs });
    },
  });

  // The shell tool, with its environment scrubbed again and its cwd pinned to the folder.
  pi.registerTool(
    createBashToolDefinition(config.root, {
      spawnHook: (ctx) => ({
        command: ctx.command,
        cwd: fencePath(ctx.cwd, fence).ok ? ctx.cwd : config.root,
        env: scrubEnv(ctx.env, { tmpDir: config.tmpDir }),
      }),
    }),
  );

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask the person',
    description:
      'Ask the person a multiple-choice question when you are unsure how to proceed. Returns their answer.',
    parameters: AskParams,
    executionMode: 'sequential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const options = params.options.slice(0, 5);
      const title = encodeRequest({ kind: 'question', question: params.question, options });
      const value = ctx.hasUI
        ? await ctx.ui.select(title, options, { timeout: config.approvalTimeoutMs })
        : undefined;
      const answer = decodeQuestionAnswer(value);
      return {
        content: [
          {
            type: 'text',
            text: answer
              ? `The person answered: ${answer}`
              : 'The person did not answer. Choose the safest option and say so.',
          },
        ],
        details: undefined,
      };
    },
  });

  pi.on('session_start', (_event, ctx) => {
    uiContext = ctx;
    // The read-only search tools are off by default in Pi; the guard fences them like read.
    pi.setActiveTools([...new Set([...pi.getActiveTools(), 'grep', 'find', 'ls'])]);
  });

  pi.on('tool_call', async (event, ctx) => {
    uiContext = ctx;
    return guard.onToolCall(event.toolName, event.input as Record<string, unknown>);
  });
}
