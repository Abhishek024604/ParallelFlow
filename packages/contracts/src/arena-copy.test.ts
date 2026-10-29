import { describe, expect, it } from 'vitest';
import {
  ChatFromArenaSchema,
  copiedFromLabel,
  encodeDragPayload,
  nameInFolder,
  normalizeFolder,
  parseDragPayload,
  planFolderRename,
  upstreamDecision,
} from './arena-copy.js';

const P = '0190a000-0000-7000-8000-000000000001';
const A = '0190a000-0000-7000-8000-000000000002';
const B = '0190a000-0000-7000-8000-000000000003';

describe('upstreamDecision', () => {
  const upstream = { project_id: P, artifact_id: A, version_no: 3 };
  it('goes back to the same arena file, warning when it moved on', () => {
    expect(
      upstreamDecision({ upstream, projectId: P, arenaFile: { id: A, head_version_no: 3 } }),
    ).toEqual({
      kind: 'same_file',
      artifact_id: A,
      copied_version_no: 3,
      arena_version_no: 3,
      newer: false,
    });
    expect(
      upstreamDecision({ upstream, projectId: P, arenaFile: { id: A, head_version_no: 5 } }),
    ).toMatchObject({ kind: 'same_file', newer: true, arena_version_no: 5 });
  });
  it('is a normal push for another arena, no upstream or a deleted file', () => {
    expect(
      upstreamDecision({ upstream, projectId: B, arenaFile: { id: A, head_version_no: 3 } }),
    ).toEqual({ kind: 'none' });
    expect(upstreamDecision({ upstream: null, projectId: P, arenaFile: null })).toEqual({
      kind: 'none',
    });
    expect(upstreamDecision({ upstream, projectId: P, arenaFile: null })).toEqual({
      kind: 'none',
    });
  });
  it('labels the copy', () => {
    expect(copiedFromLabel({ arena_name: 'Checkout', name: 'plan.md', version_no: 3 })).toBe(
      'Copied from Checkout · plan.md v3',
    );
  });
});

describe('folder moves', () => {
  const files = [
    { id: '1', name: 'pm › backlog › STORY-1.md' },
    { id: '2', name: 'pm › roadmap.md' },
    { id: '3', name: 'pmx › other.md' },
    { id: '4', name: 'notes.md' },
  ];
  it('renames every file under the folder, keeping the rest of the path', () => {
    const plan = planFolderRename(files, 'pm', 'product › pm');
    expect(plan).toEqual({
      ok: true,
      renames: [
        { id: '1', from: 'pm › backlog › STORY-1.md', to: 'product › pm › backlog › STORY-1.md' },
        { id: '2', from: 'pm › roadmap.md', to: 'product › pm › roadmap.md' },
      ],
    });
    expect(planFolderRename(files, 'pm › backlog', 'backlog')).toMatchObject({
      ok: true,
      renames: [{ id: '1', to: 'backlog › STORY-1.md' }],
    });
    expect(planFolderRename(files, 'pm › backlog', '')).toMatchObject({
      ok: true,
      renames: [{ id: '1', to: 'STORY-1.md' }],
    });
  });
  it('refuses a move into itself, to the same place, or of an empty folder', () => {
    expect(planFolderRename(files, 'pm', 'pm › backlog')).toEqual({
      ok: false,
      error: 'INTO_ITSELF',
    });
    expect(planFolderRename(files, 'pm', ' pm ')).toEqual({ ok: false, error: 'SAME_PLACE' });
    expect(planFolderRename(files, 'nope', 'x')).toEqual({ ok: false, error: 'EMPTY' });
  });
  it('moves one file between folders by name', () => {
    expect(nameInFolder('pm › roadmap.md', 'plans')).toBe('plans › roadmap.md');
    expect(nameInFolder('pm › roadmap.md', '')).toBe('roadmap.md');
    expect(normalizeFolder(' a ›  › b ')).toBe('a › b');
  });
});

describe('drag payload', () => {
  it('round-trips ids and rejects anything else', () => {
    const payload = { kind: 'arena' as const, project_id: P, artifact_id: A };
    expect(parseDragPayload(encodeDragPayload(payload))).toEqual(payload);
    expect(parseDragPayload(JSON.stringify({ kind: 'private', artifact_id: A }))).toBeNull();
    expect(parseDragPayload('not json')).toBeNull();
    expect(
      parseDragPayload(JSON.stringify({ kind: 'arena', project_id: 'x', artifact_id: A })),
    ).toBeNull();
    expect(parseDragPayload('')).toBeNull();
  });
  it('a new chat from the arena needs files or a handoff, not both', () => {
    expect(ChatFromArenaSchema.safeParse({ project_id: P, artifact_ids: [A] }).success).toBe(true);
    expect(ChatFromArenaSchema.safeParse({ project_id: P, approval_id: B }).success).toBe(true);
    expect(ChatFromArenaSchema.safeParse({ project_id: P }).success).toBe(false);
    expect(
      ChatFromArenaSchema.safeParse({ project_id: P, artifact_ids: [A], approval_id: B }).success,
    ).toBe(false);
  });
});
