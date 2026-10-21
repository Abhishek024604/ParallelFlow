import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchStore } from './store.js';

// The package's files on disk. Hosts hand the skill folders and prompt templates to Pi (VS Code:
// --skill / --prompt-template; the runtime: additionalSkillPaths / additionalPromptTemplatePaths).
// A bundling host passes `root` (the folder it copied these into).

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export interface SwaResources {
  root: string;
  systemPrompt: string;
  skills: string[];
  prompts: string[];
  template(name: string): string;
}

export function swaResources(root = PACKAGE_ROOT): SwaResources {
  const dir = (name: string) => join(root, name);
  const skills = existsSync(dir('skills'))
    ? readdirSync(dir('skills'), { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(dir('skills'), e.name, 'SKILL.md')))
        .map((e) => join(dir('skills'), e.name))
        .sort()
    : [];
  const prompts = existsSync(dir('prompts'))
    ? readdirSync(dir('prompts'))
        .filter((f) => f.endsWith('.md'))
        .map((f) => join(dir('prompts'), f))
        .sort()
    : [];
  return {
    root,
    systemPrompt: readFileSync(join(root, 'SYSTEM.md'), 'utf8').trim(),
    skills,
    prompts,
    template: (name) => readFileSync(join(dir('templates'), name), 'utf8'),
  };
}

/** /swa init: the input templates the architect fills in (never overwrites). */
export async function initInputs(store: ArchStore, resources: SwaResources): Promise<string> {
  const plan: [string, string][] = [
    ['inputs/goal.md', 'goal.md'],
    ['inputs/governance.yaml', 'governance.default.yaml'],
  ];
  const made: string[] = [];
  for (const [path, template] of plan) {
    if ((await store.read(path)) !== null) continue;
    await store.write(path, resources.template(template));
    made.push(`arch/${path}`);
  }
  const srs = (await store.read('inputs/srs.md')) !== null;
  return [
    made.length ? `Created ${made.join(' and ')}. ` : 'The input templates are already there. ',
    'Fill in arch/inputs/goal.md',
    srs ? '' : ', put the SRS at arch/inputs/srs.md (Markdown; Word and PDF are not read yet)',
    ', optionally add arch/inputs/meeting-summary.md, then run /swa intake.',
  ].join('');
}
