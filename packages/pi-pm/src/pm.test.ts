import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPmExtension, pmResources } from './index.js';

const ROUTER = join(import.meta.dirname, '..', '..', 'pi-parallelflow', 'prompts', 'pm.md');

describe('Product Manager extension', () => {
  it('ships a skill for every /pm phase the router names', () => {
    const { skills, systemPrompt } = pmResources();
    const names = skills.map((dir) => {
      const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
      const name = /^name: (.+)$/m.exec(text)?.[1];
      expect(name).toBe(basename(dir));
      expect(/^description: .{40,}$/m.test(text)).toBe(true);
      return name;
    });
    const routed = [...readFileSync(ROUTER, 'utf8').matchAll(/\bpm-[a-z-]+/g)].map((m) => m[0]);
    for (const skill of new Set(routed)) expect(names).toContain(skill);
    expect(systemPrompt).toMatch(/never invent/i);
  });

  it('adds its rules, and the Linear state, to the system prompt', async () => {
    const run = async (linear: boolean) => {
      let handler: ((event: unknown) => Promise<void>) | undefined;
      const pi = { on: (_: string, h: typeof handler) => (handler = h) };
      await createPmExtension({ linear })(pi as never);
      const event = { systemPromptOptions: { sections: {} as Record<string, string> } };
      await handler?.(event);
      return event.systemPromptOptions.sections['pm'] ?? '';
    };
    expect(await run(true)).toMatch(/Linear is connected/);
    expect(await run(false)).toMatch(/Linear is not connected/);
  });
});
