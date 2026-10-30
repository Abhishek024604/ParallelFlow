import { describe, expect, it } from 'vitest';
import {
  countActions,
  type FolderPushArenaFile,
  type FolderPushSource,
  folderPushCard,
  planFolderPush,
  PushFolderSchema,
} from './folder-push.js';

const P = '00000000-0000-4000-8000-000000000001';
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

const source = (name: string, extra: Partial<FolderPushSource> = {}): FolderPushSource => ({
  artifact_id: id(),
  version_no: 1,
  name,
  lineage_id: id(),
  sha256: `sha-${name}`,
  ...extra,
});

const arena = (name: string, extra: Partial<FolderPushArenaFile> = {}): FolderPushArenaFile => ({
  id: id(),
  name,
  lineage_id: id(),
  head_version_no: 1,
  sha256: `arena-${name}`,
  ...extra,
});

const plan = (sources: FolderPushSource[], arenaFiles: FolderPushArenaFile[] = []) =>
  planFolderPush({ projectId: P, stage: 'PLAN', sources, arenaFiles });

describe('folder push plan', () => {
  it('gives every story its own name in the folder (no more four plan.md)', () => {
    const items = plan(
      ['STORY-001.md', 'STORY-002.md', 'EPIC-001.md', 'backlog.md'].map((s) =>
        source(`pm › backlog › ${s}`),
      ),
      [arena('requirements.md')],
    );
    expect(items.map((i) => i.arena_name)).toEqual([
      'Backlog › requirements-story-001.md',
      'Backlog › requirements-story-002.md',
      'Backlog › requirements-epic-001.md',
      'Backlog › requirements-backlog.md',
    ]);
    expect(items.every((i) => i.action === 'new')).toBe(true);
  });

  it('keeps SWA names, and makes clashing names unique within the batch', () => {
    const items = plan([
      source('lld-CMP-001.md'),
      source('lld-CMP-001--openapi.yaml'),
      source('a › Notes.md'),
      source('a › notes.md'),
    ]);
    expect(items.map((i) => i.arena_name)).toEqual([
      'lld-CMP-001.md',
      'lld-CMP-001--openapi.yaml',
      'A › plan-notes.md',
      'A › plan-notes-2.md',
    ]);
  });

  it('re-push: same lineage gets a new version only when the content changed', () => {
    const same = source('pm › backlog › STORY-001.md', { sha256: 'x' });
    const changed = source('pm › backlog › STORY-002.md', { sha256: 'new' });
    const a1 = arena('Backlog › requirements-story-001.md', {
      lineage_id: same.lineage_id,
      sha256: 'x',
      head_version_no: 2,
    });
    const a2 = arena('Backlog › requirements-story-002.md', {
      lineage_id: changed.lineage_id,
      sha256: 'old',
    });
    const items = plan([same, changed], [a1, a2]);
    expect(items.map((i) => [i.action, i.arena_name, i.existing_version_no])).toEqual([
      ['unchanged', a1.name, 2],
      ['new_version', a2.name, 1],
    ]);
    expect(countActions(items)).toEqual({ new: 0, new_version: 1, unchanged: 1 });
  });

  it('a copy of an arena file goes back to that file, flagged when the arena moved on', () => {
    const target = arena('hld.md', { head_version_no: 4 });
    const copy = source('hld.md', {
      upstream: { project_id: P, artifact_id: target.id, version_no: 3 },
    });
    const [item] = plan([copy], [target]);
    expect(item).toMatchObject({
      action: 'new_version',
      arena_name: 'hld.md',
      existing_artifact_id: target.id,
      newer: true,
    });
  });

  it('a standard name already in the arena adds a version to it; two files never share one', () => {
    const existing = arena('Checkout › lld-auth.md');
    const items = plan(
      [source('checkout › lld-auth.md'), source('Checkout › lld-auth.md')],
      [existing],
    );
    expect(items[0]).toMatchObject({ action: 'new_version', existing_artifact_id: existing.id });
    expect(items[1]).toMatchObject({ action: 'new', arena_name: 'Checkout › lld-auth-2.md' });
  });

  it('validates the request and words the card', () => {
    const ok = PushFolderSchema.safeParse({
      project_id: P,
      folder: 'Architecture',
      artifact_ids: [P.toUpperCase()],
    });
    expect(ok.success && ok.data.artifact_ids[0]).toBe(P);
    expect(
      PushFolderSchema.safeParse({ project_id: P, folder: 'x', artifact_ids: [P, P] }).success,
    ).toBe(false);
    expect(
      PushFolderSchema.safeParse({ project_id: P, folder: 'x', artifact_ids: [] }).success,
    ).toBe(false);
    expect(folderPushCard('John', 'Architecture', 14)).toBe(
      'John pushed Architecture · 14 files from Private',
    );
    expect(folderPushCard('John', 'pm › backlog', 1)).toBe(
      'John pushed pm › backlog · 1 file from Private',
    );
  });
});
