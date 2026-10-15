import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@saras/stub-runtime', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@saras/stub-runtime');
  });
});
