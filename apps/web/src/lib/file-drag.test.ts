import { FILE_DRAG_TYPE } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { dragKind } from './file-drag';

describe('dragKind', () => {
  it('reads the kind of our drag from its types only', () => {
    expect(dragKind([FILE_DRAG_TYPE, `${FILE_DRAG_TYPE}-arena`])).toBe('arena');
    expect(dragKind(['text/plain', FILE_DRAG_TYPE, `${FILE_DRAG_TYPE}-folder`])).toBe('folder');
    expect(dragKind([FILE_DRAG_TYPE.toUpperCase(), `${FILE_DRAG_TYPE}-private`])).toBe('private');
  });

  it('ignores files, chats and text', () => {
    expect(dragKind(['Files'])).toBeNull();
    expect(dragKind(['application/x-parallelflow-chat'])).toBeNull();
    expect(dragKind([FILE_DRAG_TYPE])).toBeNull();
  });
});
