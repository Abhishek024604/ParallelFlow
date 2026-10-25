import { describe, expect, it } from 'vitest';
import { mermaidSource } from './markdown';

const pre = (lang: string, value: string) =>
  ({
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: [`language-${lang}`] },
        children: [{ type: 'text', value }],
      },
    ],
  }) as unknown as Parameters<typeof mermaidSource>[0];

describe('Markdown', () => {
  it('draws only ```mermaid blocks as diagrams', () => {
    expect(mermaidSource(pre('mermaid', 'flowchart LR\n  a --> b\n'))).toBe(
      'flowchart LR\n  a --> b',
    );
    expect(mermaidSource(pre('ts', 'const x = 1;'))).toBeNull();
    expect(mermaidSource(undefined)).toBeNull();
  });
});
