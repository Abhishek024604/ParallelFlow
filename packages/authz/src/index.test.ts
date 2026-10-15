import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@saras/authz', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@saras/authz');
  });
});
