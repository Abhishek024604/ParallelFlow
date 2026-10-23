import { describe, expect, it } from 'vitest';
import { dragHasFiles } from './use-file-drop';

describe('dragHasFiles', () => {
  it('accepts file drags only', () => {
    expect(dragHasFiles(['Files', 'application/x-moz-file'])).toBe(true);
    expect(dragHasFiles(['text/plain'])).toBe(false);
    expect(dragHasFiles(['application/x-parallelflow-chat'])).toBe(false);
  });
});
