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
    });
    expect(source).toEqual({
      type: 'push',
      from: 'private',
      private_version_no: 3,
      pushed_by: { id: 'u1', display_name: 'Asha' },
    });
    expect(JSON.stringify(source)).not.toContain('0190f0aa');
  });

  it('keeps only the type for other sources', () => {
    expect(
      versionSource({
        source_ref: { type: 'arena_turn' },
        created_by_type: 'agent',
        created_by: 'a1',
        display_name: null,
      }),
    ).toEqual({ type: 'arena_turn' });
    expect(
      versionSource({
        source_ref: null,
        created_by_type: 'user',
        created_by: 'u',
        display_name: 'x',
      }),
    ).toBeNull();
  });
});
