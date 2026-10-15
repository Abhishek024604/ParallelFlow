import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@saras/db', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@saras/db');
  });
});
