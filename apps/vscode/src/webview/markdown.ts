// Puts rendered markdown into a message node, then wires it with DOM code: links open through the
// host (http/https only, checked again here), code blocks get Copy and Insert at cursor.
import { button, copyText, el, send } from './dom.js';
import { safeHref } from './lib/links.js';
import { renderMarkdown } from './lib/markdown.js';

export function setMarkdown(target: HTMLElement, text: string): void {
  // markdown-it runs with html: false, so all model text arrives escaped (lib/markdown.ts).
  target.innerHTML = renderMarkdown(text);
  for (const a of target.querySelectorAll('a')) {
    const href = safeHref(a.getAttribute('href') ?? '');
    a.removeAttribute('href');
    if (!href) {
      a.replaceWith(document.createTextNode(a.textContent ?? ''));
      continue;
    }
    a.setAttribute('href', '#');
    a.title = href;
    a.addEventListener('click', (e) => {
      e.preventDefault();
      send({ type: 'openUrl', url: href });
    });
  }
  for (const pre of target.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    const source = code?.textContent ?? pre.textContent ?? '';
    const lang = /language-([\w+-]+)/.exec(code?.className ?? '')?.[1] ?? '';
    const copy = button(
      'Copy',
      () => {
        void copyText(source).then((ok) => {
          copy.textContent = ok ? 'Copied' : 'Copy failed';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        });
      },
      'ghost',
      { title: 'Copy code' },
    );
    const insert = button('Insert', () => send({ type: 'insertCode', code: source }), 'ghost', {
      title: 'Insert at cursor in the editor',
    });
    const bar = el(
      'div',
      { class: 'code-bar' },
      el('span', { class: 'code-lang' }, lang),
      copy,
      insert,
    );
    const wrap = el('div', { class: 'code-block' });
    pre.replaceWith(wrap);
    wrap.append(bar, pre);
  }
}
