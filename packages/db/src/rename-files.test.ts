import { describe, expect, it } from 'vitest';
import { type FileRow, planRenames } from './rename-files.js';

const row = (id: string, name: string, extra: Partial<FileRow> = {}): FileRow => ({
  id,
  project_id: 'p1',
  name,
  kind: 'document',
  stage: 'PLAN',
  ...extra,
});

describe('renaming arena files to standard names', () => {
  it('maps SWA documents exactly and other files by their words, unique per arena', () => {
    const renames = planRenames([
      row('1', 'arch › hld › hld.md', { stage: 'DESIGN' }),
      row('2', 'arch › inputs › srs.md'),
      row('3', 'HabitLoop_product_brief.md'),
      row('4', 'Product brief v2.md'),
      row('5', 'HabitLoop Mobile Beta Launch Plan'),
      row('6', 'notes.md', { stage: 'TEST' }),
    ]);
    expect(renames).toEqual([
      { id: '1', from: 'arch › hld › hld.md', to: 'hld.md' },
      { id: '2', from: 'arch › inputs › srs.md', to: 'requirements.md' },
      { id: '3', from: 'HabitLoop_product_brief.md', to: 'requirements-2.md' },
      { id: '4', from: 'Product brief v2.md', to: 'requirements-3.md' },
      { id: '5', from: 'HabitLoop Mobile Beta Launch Plan', to: 'plan.md' },
      { id: '6', from: 'notes.md', to: 'test.md' },
    ]);
  });

  it('leaves standard names and the arena logs alone, and keeps arenas apart', () => {
    const renames = planRenames([
      row('1', 'plan.md'),
      row('2', 'PROGRESS.md', { kind: 'progress' }),
      row('3', 'STATE.md', { kind: 'stage_summary' }),
      row('4', 'Launch plan.md'),
      row('5', 'Launch plan.md', { project_id: 'p2' }),
    ]);
    expect(renames).toEqual([
      { id: '4', from: 'Launch plan.md', to: 'plan-2.md' },
      { id: '5', from: 'Launch plan.md', to: 'plan.md' },
    ]);
  });
});
