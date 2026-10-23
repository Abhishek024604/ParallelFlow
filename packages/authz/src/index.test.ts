import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@parallelflow/authz', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@parallelflow/authz');
  });
});
