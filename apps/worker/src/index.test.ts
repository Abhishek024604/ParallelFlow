import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@saras/worker', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@saras/worker');
  });
});
