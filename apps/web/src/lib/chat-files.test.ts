import type { Artifact } from '@parallelflow/contracts';
import { describe, expect, it } from 'vitest';
import { docPlace, docTree, newest, splitName } from './chat-files';

const doc = (id: string, name: string, head = 1) =>
  ({ id, name, head_version_no: head }) as Artifact;

describe('chat files panel', () => {
  it('files documents into folders by their names, SWA ones by their arch/ path', () => {
    expect(splitName('arch › hld › hld.md')).toEqual({ folder: 'arch › hld', file: 'hld.md' });
    expect(docPlace('architecture-ADR-0003-hosting-model.md')).toEqual({
      folders: ['Architecture', 'Decisions'],
      file: 'ADR-0003-hosting-model.md',
    });
    expect(docPlace('lld-CMP-001--openapi.yaml')).toEqual({
      folders: ['Architecture', 'LLD', 'CMP-001'],
      file: 'openapi.yaml',
    });
    expect(docPlace('architecture-stack.md')).toEqual({
      folders: ['Architecture'],
      file: 'stack.md',
    });
    expect(docPlace('requirements.md')?.file).toBe('requirements.md');
    expect(docPlace('architecture-swa-state.json')).toBeNull();
    const tree = docTree([
      doc('1', 'pm › requirements.md'),
      doc('2', 'spec.md'),
      doc('3', 'architecture-ADR-0001-architecture-style.md'),
      doc('4', 'architecture-drivers.md'),
    ]);
    expect(tree.folders.map((f) => f.name)).toEqual(['Architecture', 'pm']);
    expect(tree.folders[0]?.folders.map((f) => f.name)).toEqual(['Decisions']);
    expect(tree.files.map((f) => f.file)).toEqual(['spec.md']);
  });

  it('finds the document the AI just saved: a new one or a new version', () => {
    const seen = new Map([['1', 1]]);
    expect(newest(seen, [doc('1', 'a.md')])).toBeNull();
    expect(newest(seen, [doc('1', 'a.md', 2)])?.id).toBe('1');
    expect(newest(seen, [doc('2', 'b.md'), doc('1', 'a.md')])?.id).toBe('2');
  });
});
