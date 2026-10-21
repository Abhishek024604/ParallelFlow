import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SarasProfile } from './context.js';

// The package's Pi resources on disk: skills/<name>/SKILL.md (Agent Skills spec) and prompts/*.md
// (prompt templates = slash commands). Hosts hand these paths to Pi's DefaultResourceLoader
// (additionalSkillPaths / additionalPromptTemplatePaths) with every other discovery switched off.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = join(ROOT, 'skills');
export const PROMPTS_DIR = join(ROOT, 'prompts');

/** Skills per profile. Private chats get the writing skills only. */
export const PROFILE_SKILLS: Readonly<Record<SarasProfile, readonly string[]>> = {
  central_arena: [
    'write-spec',
    'plan-cycle',
    'gate-readiness',
    'review-pr',
    'test-plan',
    'release-notes',
    'summarize-state',
    'progress-entry',
    'architecture-diagram',
  ],
  personal_private: ['write-spec', 'test-plan', 'release-notes', 'architecture-diagram'],
  coder: ['review-pr', 'test-plan'],
};

/** Slash commands per profile (prompts/<name>.md). */
export const PROFILE_COMMANDS: Readonly<Record<SarasProfile, readonly string[]>> = {
  central_arena: ['spec', 'plan', 'review', 'summarize', 'tasks', 'gate', 'diagram', 'swa'],
  personal_private: ['spec', 'summarize', 'tasks', 'diagram', 'swa'],
  coder: ['review'],
};

/** Minimal frontmatter reader (`key: value` lines, optional quotes); Pi parses the real thing. */
export function readFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv?.[1]) continue;
    data[kv[1]] = (kv[2] ?? '').trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return { data, body: match[2] ?? '' };
}

export interface SkillInfo {
  name: string;
  description: string;
  /** Path to SKILL.md. */
  file: string;
  dir: string;
}

export interface CommandInfo {
  name: string;
  description: string;
  argumentHint?: string;
  file: string;
}

/** Every skill in the package. */
export function listSkills(): SkillInfo[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => {
      const file = join(SKILLS_DIR, d.name, 'SKILL.md');
      const { data } = readFrontmatter(readFileSync(file, 'utf8'));
      return {
        name: data['name'] ?? '',
        description: data['description'] ?? '',
        file,
        dir: join(SKILLS_DIR, d.name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Every slash command (prompt template) in the package. */
export function listCommands(): CommandInfo[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const file = join(PROMPTS_DIR, f);
      const { data } = readFrontmatter(readFileSync(file, 'utf8'));
      return {
        name: f.slice(0, -3),
        description: data['description'] ?? '',
        ...(data['argument-hint'] && { argumentHint: data['argument-hint'] }),
        file,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The resource paths a host passes to Pi for one profile. */
export function resourcePaths(profile: SarasProfile): { skills: string[]; prompts: string[] } {
  return {
    skills: PROFILE_SKILLS[profile].map((name) => join(SKILLS_DIR, name)),
    prompts: PROFILE_COMMANDS[profile].map((name) => join(PROMPTS_DIR, `${name}.md`)),
  };
}

/** The profile's commands with their descriptions (for RIC capabilities and menus). */
export function commandsFor(profile: SarasProfile): Omit<CommandInfo, 'file'>[] {
  const wanted = new Set(PROFILE_COMMANDS[profile]);
  return listCommands()
    .filter((c) => wanted.has(c.name))
    .map(({ file: _file, ...c }) => c);
}
