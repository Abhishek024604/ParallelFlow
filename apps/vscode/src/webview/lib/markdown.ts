// Markdown for assistant messages. markdown-it with raw HTML off escapes everything the model
// writes; images are off (the CSP blocks remote images anyway) and links other than http(s) stay
// plain text. The DOM step (webview/markdown.ts) then wires links and code-block buttons.
import MarkdownIt from 'markdown-it';
import { safeHref } from './links.js';

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
md.disable(['image']);
md.validateLink = (url) => safeHref(url) !== undefined;

export function renderMarkdown(text: string): string {
  return md.render(text);
}
