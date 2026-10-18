// How Pi is started: `node <pi cli.js> --mode rpc` with cwd = the project folder, no discovered
// extensions/skills/themes/context files, project-local .pi config ignored, only saras-guard and the
// built-in MCP client loaded, an extension-private agent dir, and an allowlisted environment.
import type { GuardConfig } from '../shared/protocol.js';
import { scrubEnv } from '../shared/env.js';

export interface LaunchInput {
  nodePath: string;
  piCli: string;
  guardPath: string;
  root: string;
  /** Extension-private Pi agent dir (never the user's ~/.pi). */
  agentDir: string;
  tmpDir: string;
  model: string;
  systemPromptAppend: string;
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
    '--no-approve',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--provider',
    'saras',
    '--model',
    input.model,
    '--append-system-prompt',
    input.systemPromptAppend,
  ];
  const env = scrubEnv(input.hostEnv, {
    tmpDir: input.tmpDir,
    set: {
      PI_CODING_AGENT_DIR: input.agentDir,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      SARAS_GUARD_CONFIG: JSON.stringify(input.guard),
      SARAS_LLM_TOKEN: input.llmToken,
      SARAS_MCP_TOKEN: input.mcpToken,
    },
  });
  return { command: input.nodePath, args, cwd: input.root, env };
}

export const AGENT_RULES = [
  'You are working for a Saras arena team inside one project folder in VS Code.',
  'Stay inside the project folder: tools refuse paths outside it.',
  'Work only on the current task branch. Never touch main, never push, never rewrite history.',
  'Make small commits with clear messages as you go (git add + git commit).',
  'Run the project tests or type checks before you finish, and fix what you broke.',
  'Every shell command except a few read-only ones needs the person’s approval; prefer the read, grep, find and ls tools, and the saras_ide tools for symbols, diagnostics and dependencies.',
  'If you are unsure about intent or scope, use the ask_user tool with a few clear options instead of guessing.',
  'Read AGENTS.md or CLAUDE.md in the folder first if they exist.',
].join('\n');

/** Parse `v22.19.0` and check it is at least the version Pi needs. */
export function nodeVersionOk(version: string, min: [number, number] = [22, 19]): boolean {
  const m = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > min[0] || (major === min[0] && minor >= min[1]);
}
