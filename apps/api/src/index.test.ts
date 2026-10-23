import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@parallelflow/api', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@parallelflow/api');
  });
});
