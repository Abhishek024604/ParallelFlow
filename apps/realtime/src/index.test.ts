import { describe, expect, it } from 'vitest';
import { workspace } from './index.js';

describe('@saras/realtime', () => {
  it('is wired into the workspace', () => {
    expect(workspace).toBe('@saras/realtime');
  });
});
