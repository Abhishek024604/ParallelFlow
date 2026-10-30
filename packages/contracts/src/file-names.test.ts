import { describe, expect, it } from 'vitest';
import {
  arenaFoldersFor,
  arenaNameForPush,
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
      folders: [],
      leaf: 'lld-auth.md',
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

  it('accepts up to three folders in front of a standard leaf', () => {
    for (const ok of [
      'Backlog › requirements-story-001.md',
      'HLD › Flows › hld-checkout.drawio',
      'A › B › C › lld.md',
      'Sprint 1 › plan.md',
    ]) {
      expect(isStandardFileName(ok), ok).toBe(true);
    }
    for (const bad of [
      'A › B › C › D › lld.md',
      'Backlog › STORY-001.md',
      ' › plan.md',
      'Back/log › plan.md',
      '.hidden › plan.md',
      'Backlog. › plan.md',
      `${'x'.repeat(33)} › plan.md`,
    ]) {
      expect(isStandardFileName(bad), bad).toBe(false);
    }
    expect(parseFileName('HLD › Flows › hld-checkout.drawio')).toMatchObject({
      base: 'hld',
      folders: ['HLD', 'Flows'],
      leaf: 'hld-checkout.drawio',
      stage: 'DESIGN',
    });
    expect(stageOfFileName('Backlog › requirements-story-001.md')).toBe('PLAN');
  });

  it('keeps folder names when making a name unique', () => {
    expect(
      uniqueFileName('Backlog › requirements.md', new Set(['Backlog › requirements.md'])),
    ).toBe('Backlog › requirements-2.md');
  });
});

describe('names for pushed private files', () => {
  it('maps private folders to arena folders', () => {
    expect(arenaFoldersFor(['pm', 'backlog'])).toEqual(['Backlog']);
    expect(arenaFoldersFor(['Architecture', 'LLD'])).toEqual(['LLD']);
    expect(arenaFoldersFor(['Architecture', 'HLD', 'Flows'])).toEqual(['HLD', 'Flows']);
    expect(arenaFoldersFor(['checkout', 'specs', 'v2', 'drafts'])).toEqual([
      'Checkout',
      'Specs',
      'V2',
    ]);
    expect(arenaFoldersFor(['pm'])).toEqual([]);
    expect(arenaFoldersFor(['ünïcode/stuff?'])).toEqual(['Unicode-stuff']);
  });

  it('gives each file of a folder a suffix from its own name', () => {
    const opts = { alwaysSuffix: true } as const;
    expect(arenaNameForPush('pm › backlog › STORY-001.md', opts)).toBe(
      'Backlog › requirements-story-001.md',
    );
    expect(arenaNameForPush('pm › backlog › EPIC-001.md', opts)).toBe(
      'Backlog › requirements-epic-001.md',
    );
    expect(arenaNameForPush('Architecture › LLD › CMP-002.md', opts)).toBe('LLD › lld-cmp-002.md');
    expect(arenaNameForPush('Architecture › HLD › Flows › checkout.drawio', opts)).toBe(
      'HLD › Flows › hld-checkout.drawio',
    );
    expect(arenaNameForPush('checkout › Requirements v2.md', opts)).toBe(
      'Checkout › requirements-v2.md',
    );
  });

  it('keeps a standard leaf, and SWA names stay flat', () => {
    expect(arenaNameForPush('checkout › lld-auth.md')).toBe('Checkout › lld-auth.md');
    expect(arenaNameForPush('lld-CMP-001--openapi.yaml', { alwaysSuffix: true })).toBe(
      'lld-CMP-001--openapi.yaml',
    );
    expect(arenaNameForPush('hld.md', { taken: new Set(['hld.md']) })).toBe('hld.md');
  });

  it('one file: the bare base when free, else a suffix from its name (no collisions)', () => {
    expect(arenaNameForPush('STORY-001.md')).toBe('requirements.md');
    const taken = new Set(['requirements.md']);
    expect(arenaNameForPush('STORY-002.md', { taken })).toBe('requirements-story-002.md');
    taken.add('requirements-story-002.md');
    expect(arenaNameForPush('STORY-002.md', { taken })).toBe('requirements-story-002-2.md');
    expect(arenaNameForPush('notes.md', { stage: 'TEST', taken: new Set(['test.md']) })).toBe(
      'test-notes.md',
    );
  });
});
