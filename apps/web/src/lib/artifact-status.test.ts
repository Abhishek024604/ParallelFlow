import { describe, expect, it } from 'vitest';
import { artifactStatus, isApproved } from './artifact-status';

describe('arena file status', () => {
  it('labels drafts, approved and newer drafts of approved documents', () => {
    expect(artifactStatus({ approved_version_no: null, head_version_no: 2 }).label).toBe('draft');
    expect(artifactStatus({ approved_version_no: 2, head_version_no: 2 }).label).toBe('approved');
    expect(artifactStatus({ approved_version_no: 1, head_version_no: 3 }).label).toBe(
      'v1 approved',
    );
    expect(isApproved({ approved_version_no: null })).toBe(false);
    expect(
      artifactStatus({ kind: 'progress', approved_version_no: null, head_version_no: 4 }).label,
    ).toBe('log');
  });
});
