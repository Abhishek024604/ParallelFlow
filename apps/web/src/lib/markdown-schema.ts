import { defaultSchema, type Options } from 'rehype-sanitize';

// Sanitised markdown (doc 10 §10.5): no raw HTML from people or the AI. react-markdown never
// parses raw HTML (no rehype-raw), and rehype-sanitize then allows only GitHub's safe subset minus
// images and form inputs (no remote loads, no tracking pixels), with links limited to http(s) and
// mailto. Attributes like `style` and event handlers are never allowed.

const BLOCKED_TAGS = new Set(['img', 'input', 'picture', 'source', 'video', 'audio', 'iframe']);

export const MARKDOWN_SCHEMA: Options = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => !BLOCKED_TAGS.has(tag)),
  protocols: { href: ['http', 'https', 'mailto'] },
  attributes: {
    ...defaultSchema.attributes,
    a: ['href', 'title'],
    '*': ['title'],
  },
};
