import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';

// @parallelflow/pi-pm: the Product Manager, a private extension (ADR-039; the PM workflow spec in
// docs/). It is workflows and skills only: the agent proposes and documents, the product owner
// decides, and no gate is enforced in code (an owner's Approve in the app is the record). The
// /pm router is a pi-parallelflow prompt template; this package adds the PM rules to the system
// prompt and the phase skills. pm/ files are the private chat's documents ("pm › requirements.md"),
// read and written with the chat's App Tools. Linear is a connector (pi-parallelflow LINEAR).

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface PmResources {
  systemPrompt: string;
  /** Skill folders (each with SKILL.md). */
  skills: string[];
}

export function pmResources(root = PACKAGE_ROOT): PmResources {
  const dir = join(root, 'skills');
  const skills = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'SKILL.md')))
        .map((e) => join(dir, e.name))
        .sort()
    : [];
  return { systemPrompt: readFileSync(join(root, 'SYSTEM.md'), 'utf8').trim(), skills };
}

export interface PmExtensionOptions {
  /** Whether Linear is connected this session (its tools are then listed to the model). */
  linear?: boolean;
  resources?: PmResources;
}

const LINEAR_OFF =
  'Linear is not connected. For tracker work, say they can connect Linear in Extensions (Private sidebar) and offer a Markdown export instead.';
const LINEAR_ON =
  'Linear is connected: its tools are named mcp__linear__*. Read freely; before any create or update, show the exact changes and get a yes with ask_user (load the pm-linear-sync skill).';

/** The PM rules (SYSTEM.md) and the Linear state, as a system prompt section on every run. */
export function createPmExtension(options: PmExtensionOptions = {}): ExtensionFactory {
  const resources = options.resources ?? pmResources();
  return async (pi: ExtensionAPI) => {
    pi.on('before_agent_start', async (event) => {
      event.systemPromptOptions.sections['pm'] =
        `${resources.systemPrompt}\n\n${options.linear ? LINEAR_ON : LINEAR_OFF}`;
    });
  };
}
