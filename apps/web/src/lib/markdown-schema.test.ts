import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import rehypeSanitize from 'rehype-sanitize';
import { describe, expect, it } from 'vitest';
import { MARKDOWN_SCHEMA } from './markdown-schema';

const render = (text: string) =>
  renderToStaticMarkup(
    createElement(Markdown, { rehypePlugins: [[rehypeSanitize, MARKDOWN_SCHEMA]] }, text),
  );

describe('sanitised markdown', () => {
  it('renders ordinary markdown', () => {
    const html = render('# Goal\n\n**Ship** it. [Docs](https://example.com)');
    expect(html).toContain('<h1>Goal</h1>');
    expect(html).toContain('<strong>Ship</strong>');
    expect(html).toContain('href="https://example.com"');
  });

  it('never renders raw HTML or scripts', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<div onclick="x">hi</div>\n\n<iframe src="x">',
    );
    expect(html).not.toMatch(/<script|<div|<iframe|onclick/i);
  });

  it('drops javascript: and data: links', () => {
    const html = render('[a](javascript:alert(1)) [b](data:text/html,x)');
    expect(html).not.toMatch(/javascript:|data:/i);
  });

  it('drops images (no remote loads)', () => {
    expect(render('![x](https://tracker.example/p.png)')).not.toContain('<img');
  });

  it('allows only safe tags and link protocols', () => {
    expect(MARKDOWN_SCHEMA.tagNames).not.toContain('img');
    expect(MARKDOWN_SCHEMA.tagNames).not.toContain('iframe');
    expect(MARKDOWN_SCHEMA.protocols).toEqual({ href: ['http', 'https', 'mailto'] });
    expect(MARKDOWN_SCHEMA.attributes?.['*']).toEqual(['title']);
  });
});
