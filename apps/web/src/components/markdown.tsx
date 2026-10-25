'use client';

import Markdown, { type ExtraProps } from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { MARKDOWN_SCHEMA } from '../lib/markdown-schema';
import { MermaidDiagram } from './mermaid-diagram';

type Element = NonNullable<ExtraProps['node']>;

/** The source of a ```mermaid block (`<pre><code class="language-mermaid">`), else null. */
export function mermaidSource(pre: Element | undefined): string | null {
  const code = pre?.children[0];
  if (code?.type !== 'element' || code.tagName !== 'code') return null;
  const classes = code.properties['className'];
  if (!Array.isArray(classes) || !classes.includes('language-mermaid')) return null;
  return code.children
    .map((c) => (c.type === 'text' ? c.value : ''))
    .join('')
    .trim();
}

/**
 * Sanitised markdown (lib/markdown-schema.ts). Links open in a new tab without a referrer;
 * ```mermaid blocks are drawn as diagrams.
 */
export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="md">
      <Markdown
        rehypePlugins={[[rehypeSanitize, MARKDOWN_SCHEMA]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          pre: ({ node, children }) => {
            const source = mermaidSource(node);
            return source ? <MermaidDiagram source={source} /> : <pre>{children}</pre>;
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
