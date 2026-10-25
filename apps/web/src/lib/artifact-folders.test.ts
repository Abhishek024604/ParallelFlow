import type { Artifact } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { arenaLogs, groupByStage, visibleCount } from './artifact-folders';

const file = (name: string, extra: Partial<Artifact> = {}) =>
  ({ id: name, name, kind: 'document', stage: null, ...extra }) as Artifact;

describe('groupByStage', () => {
  it('files arena documents by their standard name into stage folders, with no sub-folders', () => {
    const folders = groupByStage([
      file('lld-auth.md', { stage: 'PLAN' }),
      file('hld.md'),
      file('test-e2e.md'),
      file('plan.md'),
      file('requirements.md', { stage: 'BUILD' }),
      file('maintain-runbook.md'),
    ]);
    expect(folders.map((f) => f.label)).toEqual([
      'Plan',
      'Design',
      'Build',
      'Test',
      'Deploy',
      'Maintain',
    ]);
    expect(folders[0]!.files.map((a) => a.name)).toEqual(['plan.md', 'requirements.md']);
    expect(folders[1]!.files.map((a) => a.name)).toEqual(['lld-auth.md', 'hld.md']);
    expect(folders[3]!.files.map((a) => a.name)).toEqual(['test-e2e.md']);
    expect(folders[5]!.files.map((a) => a.name)).toEqual(['maintain-runbook.md']);
    expect(Object.keys(folders[1]!)).not.toContain('subfolders');
  });

  it('places files saved before the naming rule by stage, then kind, else Plan', () => {
    const folders = groupByStage([
      file('Old brief.md', { stage: 'DESIGN' }),
      file('report.md', { kind: 'test_report' }),
      file('misc.md'),
    ]);
    expect(folders[1]!.files.map((a) => a.name)).toEqual(['Old brief.md']);
    expect(folders[3]!.files.map((a) => a.name)).toEqual(['report.md']);
    expect(folders[0]!.files.map((a) => a.name)).toEqual(['misc.md']);
  });

  it('keeps PROGRESS.md and STATE.md out of the stage folders, and hides SWA state', () => {
    const items = [
      file('STATE.md', { kind: 'stage_summary', stage: 'BUILD' }),
      file('requirements.md', { kind: 'spec' }),
      file('PROGRESS.md', { kind: 'progress', stage: 'PLAN' }),
      file('architecture-swa-state.json'),
    ];
    expect(arenaLogs(items).map((a) => a.name)).toEqual(['PROGRESS.md', 'STATE.md']);
    expect(
      groupByStage(items)
        .flatMap((f) => f.files)
        .map((a) => a.name),
    ).toEqual(['requirements.md']);
    expect(visibleCount(items)).toBe(3);
  });
});
