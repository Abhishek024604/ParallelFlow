import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@parallelflow/worker', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@parallelflow/worker');
  });
});
