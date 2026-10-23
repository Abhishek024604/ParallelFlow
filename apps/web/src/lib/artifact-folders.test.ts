import type { Artifact } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { groupByStage } from './artifact-folders';

const file = (name: string, extra: Partial<Artifact> = {}) =>
  ({ id: name, name, kind: 'document', stage: null, ...extra }) as Artifact;

describe('groupByStage', () => {
  it('files arena documents into stage folders in loop order, with Design sub-folders', () => {
    const folders = groupByStage([
      file('auth_hld.md', { stage: 'DESIGN' }),
      file('login screens.md', { stage: 'DESIGN' }),
      file('notes.md', { stage: 'DESIGN' }),
      file('test-report.md', { kind: 'test_report' }),
      file('goal.md', { stage: 'PLAN' }),
      file('misc.md'),
    ]);
    expect(folders.map((f) => f.label)).toEqual([
      'Plan',
      'Design',
      'Build',
      'Test',
      'Deploy',
      'Maintain',
    ]);
    expect(folders[0]!.files.map((a) => a.name)).toEqual(['goal.md', 'misc.md']);
    const design = folders[1]!;
    expect(design.files.map((a) => a.name)).toEqual(['notes.md']);
    expect(design.subfolders.find((s) => s.key === 'hld')!.files.map((a) => a.name)).toEqual([
      'auth_hld.md',
    ]);
    expect(design.subfolders.find((s) => s.key === 'ui')!.files.map((a) => a.name)).toEqual([
      'login screens.md',
    ]);
    expect(folders[3]!.count).toBe(1);
  });
});
