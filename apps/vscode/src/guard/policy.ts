// The parallelflow-guard decision logic, separate from the Pi entry point so it can be unit tested.
import * as fs from 'node:fs';
import * as os from 'node:os';
import { matchAllowlist } from '../shared/commands.js';
import { checkPattern, fencePath, type FenceOptions, writeRule } from '../shared/fence.js';
import {
  decodeDecision,
  encodeRequest,
  type GuardConfig,
  SELECT_OPTIONS,
} from '../shared/protocol.js';

export const MCP_SERVER_NAME = 'parallelflow_ide';

export type Block = { block: true; reason: string };

export function fenceOptions(root: string): FenceOptions {
  return {
    root,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
    homedir: os.homedir(),
    fs: {
      lexists: (p) => {
        try {
          fs.lstatSync(p);
          return true;
        } catch {
          return false;
        }
      },
      realpath: (p) => fs.realpathSync.native(p),
    },
  };
}

export interface GuardDeps {
  config: GuardConfig;
  fence: FenceOptions;
  /** Ask the person (Pi extension UI select). Resolves undefined on timeout or cancel. */
  ask(title: string, options: string[], timeoutMs: number): Promise<string | undefined>;
}

export function createGuard(deps: GuardDeps) {
  const { config, fence } = deps;
  const sessionApproved = new Set<string>();
  const inside = (arg: string) => fencePath(arg, fence).ok;

  async function askCommand(command: string, reason: string): Promise<Block | undefined> {
    if (sessionApproved.has(command)) return undefined;
    const title = encodeRequest({ kind: 'command', command, cwd: config.root, reason });
    const answer = decodeDecision(await deps.ask(title, SELECT_OPTIONS, config.approvalTimeoutMs));
    if (answer.decision === 'approve_session') sessionApproved.add(command);
    if (answer.decision === 'deny') {
      return block(`The person denied this command${answer.reason ? `: ${answer.reason}` : '.'}`);
    }
    return undefined;
  }

  async function askEdit(tool: string, path: string, reason: string): Promise<Block | undefined> {
    const title = encodeRequest({ kind: 'edit', tool, path, reason });
    const answer = decodeDecision(await deps.ask(title, SELECT_OPTIONS, config.approvalTimeoutMs));
    if (answer.decision === 'deny') {
      return block(`The person denied this edit${answer.reason ? `: ${answer.reason}` : '.'}`);
    }
    return undefined;
  }

  return {
    sessionApproved,
    async onToolCall(toolName: string, input: Record<string, unknown>): Promise<Block | undefined> {
      if (toolName.startsWith(`mcp__${MCP_SERVER_NAME}__`)) return undefined;
      switch (toolName) {
        case 'ask_user':
        case 'load_skill': // parallelflow-agent: reads one of its bundled skill files, nothing else
          return undefined;
        // SWA (Architect mode, packages/pi-swa): these touch only <folder>/arch, through pi-swa's
        // own checks (no path outside arch/, no symlink out, inputs and approvals read-only).
        case 'swa_status':
        case 'swa_read':
        case 'swa_validate':
        case 'swa_governance_check':
        case 'swa_trace':
        case 'swa_diagram_sync':
        case 'swa_lld_check':
          return undefined;
        case 'swa_write':
        case 'swa_diagram_save':
        case 'swa_impact': {
          if (config.autoApproveEdits) return undefined;
          const target =
            typeof input.path === 'string'
              ? `arch/${input.path.replace(/^(\.\/)?arch\//, '')}`
              : 'arch/';
          return askEdit(toolName, target, 'Edits need approval');
        }
        case 'read':
        case 'ls':
        case 'find':
        case 'grep': {
          const raw = typeof input.path === 'string' ? input.path : '.';
          const res = fencePath(raw, fence);
          if (!res.ok) return block(res.reason);
          input.path = res.path;
          for (const key of ['pattern', 'glob'] as const) {
            if (toolName === 'grep' && key === 'pattern') continue; // a regex, not a path
            const v = input[key];
            if (typeof v === 'string') {
              const bad = checkPattern(v, fence.platform);
              if (bad) return block(bad);
            }
          }
          return undefined;
        }
        case 'write':
        case 'edit': {
          if (typeof input.path !== 'string') return block('A file path is required');
          const res = fencePath(input.path, fence);
          if (!res.ok) return block(res.reason);
          const rule = writeRule(res.relative, fence.platform);
          if (rule === 'block') return block('Files inside .git cannot be changed by the agent');
          input.path = res.path;
          if (rule === 'ask') {
            return askEdit(
              toolName,
              res.relative,
              'Changes editor, container, CI or agent settings',
            );
          }
          if (!config.autoApproveEdits)
            return askEdit(toolName, res.relative, 'Edits need approval');
          return undefined;
        }
        case 'bash': {
          const command = typeof input.command === 'string' ? input.command : '';
          if (command.trim() === '') return block('Empty command');
          const decision = matchAllowlist(command, config.allowlist, inside);
          if (decision.auto) return undefined;
          return askCommand(command, decision.reason);
        }
        default:
          return block(`The ${toolName} tool is not available in ParallelFlow`);
      }
    },
  };
}

export function block(reason: string): Block {
  return { block: true, reason };
}
