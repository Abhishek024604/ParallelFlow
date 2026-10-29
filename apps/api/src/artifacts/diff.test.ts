import { describe, expect, it } from 'vitest';
import { diffLines, lineDiff } from './diff.js';

describe('lineDiff', () => {
  it('counts nothing for equal text', () => {
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual({ added: 0, removed: 0 });
  });

  it('counts added and removed lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
  });

  it('treats a new file as all added', () => {
    expect(lineDiff('', 'one\ntwo')).toEqual({ added: 2, removed: 0 });
  });

  it('ignores line-ending style and a final newline', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });

  it('counts a moved line as one removed and one added', () => {
    expect(lineDiff('a\nb\nc', 'b\nc\na')).toEqual({ added: 1, removed: 1 });
  });

  it('stays fast on large inputs (multiset fallback)', () => {
    const before = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, i) => `line ${(i * 7) % 3000}`).join('\n');
    expect(lineDiff(before, after)).toEqual({ added: 0, removed: 0 });
  });
});

describe('diffLines', () => {
  it('shows kept, removed and added lines in order, cut at the limit', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc').lines).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'x' },
      { op: ' ', text: 'c' },
    ]);
    const cut = diffLines('', 'one\ntwo\nthree', 2);
    expect(cut).toEqual({
      lines: [
        { op: '+', text: 'one' },
        { op: '+', text: 'two' },
      ],
      truncated: true,
    });
  });
});
