import type { Artifact } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { groupByFolder, newest, splitName } from './chat-files';

const doc = (id: string, name: string, head = 1) =>
  ({ id, name, head_version_no: head }) as Artifact;

describe('chat files panel', () => {
  it('files documents into folders by their names, loose ones first', () => {
    expect(splitName('arch › hld › hld.md')).toEqual({ folder: 'arch › hld', file: 'hld.md' });
    const groups = groupByFolder([
      doc('1', 'pm › requirements.md'),
      doc('2', 'spec.md'),
      doc('3', 'arch › stack.md'),
    ]);
    expect(groups.map((g) => g.folder)).toEqual(['', 'arch', 'pm']);
  });

  it('finds the document the AI just saved: a new one or a new version', () => {
    const seen = new Map([['1', 1]]);
    expect(newest(seen, [doc('1', 'a.md')])).toBeNull();
    expect(newest(seen, [doc('1', 'a.md', 2)])?.id).toBe('1');
    expect(newest(seen, [doc('2', 'b.md'), doc('1', 'a.md')])?.id).toBe('2');
  });
});
