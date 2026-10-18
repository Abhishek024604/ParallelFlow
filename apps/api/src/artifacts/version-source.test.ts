import { authorLabel, sourceLabel } from '@saras/contracts';
import { describe, expect, it } from 'vitest';
import { versionSource } from './artifacts.js';

describe('versionSource', () => {
  it('maps a push to its Private version and pusher, without private ids', () => {
    const source = versionSource({
      source_ref: {
        type: 'push',
        artifact_id: '0190f0aa-0000-7000-8000-000000000001',
        version_no: 3,
        private_session_id: '0190f0aa-0000-7000-8000-000000000002',
      } as { type: string; version_no: number },
      created_by_type: 'user',
      created_by: 'u1',
      display_name: 'Asha',
      version_no: 2,
    });
    expect(source).toEqual({
      type: 'push',
      label: 'Pushed from Private v3 by Asha',
      from: 'private',
      private_version_no: 3,
      pushed_by: { id: 'u1', display_name: 'Asha' },
    });
    expect(JSON.stringify(source)).not.toContain('0190f0aa');
  });

  it('labels AI and human versions in plain words', () => {
    expect(
      versionSource({
        source_ref: { type: 'arena_turn' },
        created_by_type: 'agent',
        created_by: 'a1',
        display_name: null,
        version_no: 1,
        on_behalf_name: 'Ravi',
      }),
    ).toEqual({ type: 'arena_turn', label: 'Written by AI for Ravi' });
    expect(
      versionSource({
        source_ref: null,
        created_by_type: 'user',
        created_by: 'u',
        display_name: 'x',
        version_no: 1,
      }),
    ).toBeNull();
    const facts = {
      sourceType: 'upload',
      authorType: 'user' as const,
      authorName: 'Asha',
      onBehalfOfName: null,
      versionNo: 1,
    };
    expect(sourceLabel(facts)).toBe('Uploaded by Asha');
    expect(sourceLabel({ ...facts, versionNo: 2 })).toBe('Edited by Asha');
    expect(authorLabel({ ...facts, authorType: 'agent', authorName: null })).toBe('AI');
  });
});
