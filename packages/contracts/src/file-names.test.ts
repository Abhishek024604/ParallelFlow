import { describe, expect, it } from 'vitest';
import {
  isStandardFileName,
  parseFileName,
  stageOfFileName,
  suggestFileName,
  uniqueFileName,
} from './file-names.js';

describe('standard arena file names', () => {
  it('accepts a base, an optional suffix and an extension, and the arena’s own files', () => {
    for (const ok of [
      'plan.md',
      'requirements.md',
      'hld.md',
      'lld-auth.md',
      'architecture-stack.md',
      'test-e2e.md',
      'deploy.md',
      'maintain-runbook.md',
      'architecture-model.yaml',
      'hld-context.drawio',
      'README.md',
      'PROGRESS.md',
      'STATE.md',
    ]) {
      expect(isStandardFileName(ok), ok).toBe(true);
    }
    for (const bad of [
      'HabitLoop_product_brief.md',
      'Plan.md',
      'design.md',
      'plan',
      'plan-.md',
      'plan-x..md',
      'notes.txt',
      'hld/x.md',
      'readme.md',
    ]) {
      expect(isStandardFileName(bad), bad).toBe(false);
    }
  });

  it('files each base under its stage', () => {
    expect(parseFileName('lld-auth.md')).toEqual({
      base: 'lld',
      suffix: 'auth',
      ext: 'md',
      stage: 'DESIGN',
    });
    expect(stageOfFileName('requirements.md')).toBe('PLAN');
    expect(stageOfFileName('test-e2e.md')).toBe('TEST');
    expect(stageOfFileName('maintain.md')).toBe('MAINTAIN');
    expect(stageOfFileName('PROGRESS.md')).toBeNull();
  });

  it('suggests a standard name from any name', () => {
    expect(suggestFileName('HabitLoop_product_brief.md')).toBe('requirements.md');
    expect(suggestFileName('HabitLoop Mobile Beta Launch Plan')).toBe('plan.md');
    expect(suggestFileName('Auth service LLD.md')).toBe('lld.md');
    expect(suggestFileName('notes.md', 'TEST')).toBe('test.md');
    expect(suggestFileName('hld.md')).toBe('hld.md');
  });

  it('keeps names unique with a numeric suffix', () => {
    expect(uniqueFileName('plan.md', new Set())).toBe('plan.md');
    expect(uniqueFileName('plan.md', new Set(['plan.md', 'plan-2.md']))).toBe('plan-3.md');
    expect(uniqueFileName('lld-auth.md', new Set(['lld-auth.md']))).toBe('lld-auth-2.md');
  });
});
