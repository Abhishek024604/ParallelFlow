import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@parallelflow/ui', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@parallelflow/ui');
  });
});
