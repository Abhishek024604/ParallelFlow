// How Pi is started: `node <pi cli.js> --mode rpc` with cwd = the project folder, no discovered
// extensions/skills/themes/context files, project-local .pi config ignored, only the built-in MCP
// client, saras-guard and saras-agent (the Saras Pi extension) loaded with the coder profile's
// skills and prompt templates, an extension-private agent dir, and an allowlisted environment.
import type { AgentConfig } from '../shared/agent-config.js';
import type { GuardConfig } from '../shared/protocol.js';
import { scrubEnv } from '../shared/env.js';

export interface LaunchInput {
  nodePath: string;
  piCli: string;
  guardPath: string;
  /** dist/agent/saras-agent.mjs */
  agentPath: string;
  /** The coder profile's skill folders and prompt template files (dist/skills, dist/prompts). */
  skillPaths: readonly string[];
  promptPaths: readonly string[];
  agent: AgentConfig;
  root: string;
  /** Extension-private Pi agent dir (never the user's ~/.pi). */
  agentDir: string;
  tmpDir: string;
  /** `saras` provider model id; `auto` = saras-agent's router. */
  model: string;
  guard: GuardConfig;
  llmToken: string;
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
    '--no-session',
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
    'saras',
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
      SARAS_GUARD_CONFIG: JSON.stringify(input.guard),
      SARAS_AGENT_CONFIG: JSON.stringify(input.agent),
      SARAS_LLM_TOKEN: input.llmToken,
      SARAS_MCP_TOKEN: input.mcpToken,
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
