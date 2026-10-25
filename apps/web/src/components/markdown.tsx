'use client';

import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { MARKDOWN_SCHEMA } from '../lib/markdown-schema';

/** Sanitised markdown (lib/markdown-schema.ts). Links open in a new tab without a referrer. */
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
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
