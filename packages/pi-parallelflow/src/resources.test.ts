import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { AI_COMMANDS } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import {
  commandsFor,
  listCommands,
  listSkills,
  PROFILE_COMMANDS,
  PROFILE_SKILLS,
  profileCommands,
  readFrontmatter,
  resourcePaths,
} from './resources.js';

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

describe('skills and prompt templates', () => {
  it('every SKILL.md parses with a valid, unique name matching its folder and a routing description', () => {
    const skills = listSkills();
    expect(skills.length).toBeGreaterThanOrEqual(7);
    for (const skill of skills) {
      expect(skill.name).toMatch(SKILL_NAME);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(basename(skill.dir)).toBe(skill.name);
      expect(skill.description.length).toBeGreaterThan(40);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).toMatch(/Use when/);
      expect(readFrontmatter(readFileSync(skill.file, 'utf8')).body.trim().length).toBeGreaterThan(
        100,
      );
    }
    expect(new Set(skills.map((s) => s.name)).size).toBe(skills.length);
    const names = new Set(skills.map((s) => s.name));
    for (const list of Object.values(PROFILE_SKILLS))
      for (const n of list) expect(names).toContain(n);
    expect(PROFILE_SKILLS.personal_private).toEqual([
      'write-spec',
      'test-plan',
      'release-notes',
      'architecture-diagram',
    ]);
  });

  it('prompt templates match the app command list (names, descriptions, hints, surfaces)', () => {
    const commands = listCommands();
    expect(commands.map((c) => c.name).sort()).toEqual(AI_COMMANDS.map((c) => c.name).sort());
    for (const c of AI_COMMANDS) {
      const template = commands.find((t) => t.name === c.name)!;
      expect(template.description).toBe(c.description);
      expect(template.argumentHint).toBe(c.argumentHint);
      expect(PROFILE_COMMANDS.central_arena.includes(c.name)).toBe(c.surfaces.includes('arena'));
      expect(
        profileCommands('personal_private', c.extension ? [c.extension] : []).includes(c.name),
      ).toBe(c.surfaces.includes('private'));
      // Templates only use the substitutions Pi supports.
      const body = readFrontmatter(readFileSync(template.file, 'utf8')).body;
      expect(body).not.toMatch(/\$\{[^}]*:\+/);
    }
    expect(commandsFor('personal_private').map((c) => c.name)).toEqual([
      'diagram',
      'spec',
      'summarize',
      'tasks',
    ]);
    expect(commandsFor('personal_private', ['pm', 'swa']).map((c) => c.name)).toContain('pm');
    expect(commandsFor('central_arena', ['pm', 'swa']).map((c) => c.name)).not.toContain('swa');
    expect(resourcePaths('central_arena').prompts).toHaveLength(7);
  });
});
