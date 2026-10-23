// How Pi is started: `node <pi cli.js> --mode rpc` with cwd = the project folder, no discovered
// extensions/skills/themes/context files, project-local .pi config ignored, only the built-in MCP
// client, parallelflow-guard and parallelflow-agent (the ParallelFlow Pi extension) loaded with the coder profile's
// skills and prompt templates, an extension-private agent dir, and an allowlisted environment.
import type { AgentConfig } from '../shared/agent-config.js';
import type { GuardConfig } from '../shared/protocol.js';
import { scrubEnv } from '../shared/env.js';

export interface LaunchInput {
  nodePath: string;
  piCli: string;
  guardPath: string;
  /** dist/agent/parallelflow-agent.mjs */
  agentPath: string;
  /** The coder profile's skill folders and prompt template files (dist/skills, dist/prompts). */
  skillPaths: readonly string[];
  promptPaths: readonly string[];
  agent: AgentConfig;
  root: string;
  /** Extension-private Pi agent dir (never the user's ~/.pi). */
  agentDir: string;
  /** This folder's chats (pi/sessions.ts sessionDirFor). */
  sessionDir: string;
  tmpDir: string;
  /** `parallelflow` (the ParallelFlow LLM proxy) or `anthropic` (the person's Claude subscription). */
  provider: string;
  /** Model id on that provider; `auto` = parallelflow-agent's router (always on the `parallelflow` provider). */
  model: string;
  guard: GuardConfig;
  llmToken: string;
  /** The person's Claude subscription token, when the agent runs on it. */
  claudeToken?: string;
  mcpToken: string;
  hostEnv: Readonly<Record<string, string | undefined>>;
}

export interface LaunchSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function buildPiLaunch(input: LaunchInput): LaunchSpec {
  const args = [
    input.piCli,
    '--mode',
    'rpc',
    // The chat is saved and the latest one continued, so a reload or crash does not lose it.
    '--session-dir',
    input.sessionDir,
    '--continue',
    '--offline',
    '--no-extensions',
    '--extension',
    'builtin:mcp',
    '--extension',
    input.guardPath,
    '--extension',
    input.agentPath,
    // Explicit paths still load with discovery off (--no-skills / --no-prompt-templates).
    ...input.skillPaths.flatMap((p) => ['--skill', p]),
    ...input.promptPaths.flatMap((p) => ['--prompt-template', p]),
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--provider',
    input.provider,
    '--model',
    input.model,
  ];
  const env = scrubEnv(input.hostEnv, {
    tmpDir: input.tmpDir,
    set: {
      PI_CODING_AGENT_DIR: input.agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      PARALLELFLOW_GUARD_CONFIG: JSON.stringify(input.guard),
      PARALLELFLOW_AGENT_CONFIG: JSON.stringify(input.agent),
      PARALLELFLOW_LLM_TOKEN: input.llmToken,
      PARALLELFLOW_MCP_TOKEN: input.mcpToken,
      ...(input.claudeToken && { PARALLELFLOW_CLAUDE_TOKEN: input.claudeToken }),
    },
  });
  return { command: input.nodePath, args, cwd: input.root, env };
}

/** Parse `v22.19.0` and check it is at least the version Pi needs. */
export function nodeVersionOk(version: string, min: [number, number] = [22, 19]): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}
