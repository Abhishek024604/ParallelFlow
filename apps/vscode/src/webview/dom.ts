// DOM helpers for the chat webview. Text goes in as text nodes (never innerHTML with data); the
// only innerHTML is markdown-it output (webview/markdown.ts). Handlers are attached in code, since
// the CSP forbids inline ones.
import type { FromWebview, HostCommand } from '../shared/messages.js';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
const api = acquireVsCodeApi();

export const send = (m: FromWebview): void => api.postMessage(m);
export const command = (c: HostCommand) => () => send({ type: 'command', command: c });

export type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

/** A codicon (decorative; the control around it carries the label). */
export function icon(name: string, extra = ''): HTMLElement {
  return el('span', {
    class: `codicon codicon-${name}${extra ? ` ${extra}` : ''}`,
    'aria-hidden': 'true',
  });
}

export function button(
  label: Child,
  onClick: (e: MouseEvent) => void,
  kind: 'primary' | 'secondary' | 'ghost' = 'secondary',
  opts: { disabled?: boolean; title?: string; icon?: string } = {},
): HTMLButtonElement {
  const b = el(
    'button',
    { class: `btn ${kind}`, type: 'button' },
    opts.icon ? icon(opts.icon) : null,
    label,
  );
  if (opts.title) b.title = opts.title;
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** A square icon-only button with an accessible label and tooltip. */
export function iconButton(
  name: string,
  label: string,
  onClick: (e: MouseEvent) => void,
  opts: { disabled?: boolean } = {},
): HTMLButtonElement {
  const b = el(
    'button',
    { class: 'icon-btn', type: 'button', 'aria-label': label, title: label },
    icon(name),
  );
  b.disabled = !!opts.disabled;
  b.addEventListener('click', onClick);
  return b;
}

/** A link-looking button for an http(s) URL, opened by the host. */
export function urlLink(label: string, url: string): HTMLElement {
  const a = el('a', { href: '#', title: url }, label);
  a.addEventListener('click', (e) => {
    e.preventDefault();
    send({ type: 'openUrl', url });
  });
  return a;
}

/** "src/ui/" muted + "file.ts" for a path. */
export function pathLabel(path: string): HTMLElement {
  const norm = path.replace(/\\/g, '/');
  const cut = norm.lastIndexOf('/');
  return el(
    'span',
    { class: 'path', title: path },
    el('span', { class: 'path-name' }, cut >= 0 ? norm.slice(cut + 1) : norm),
    cut >= 0 ? el('span', { class: 'path-dir' }, ` ${norm.slice(0, cut)}`) : null,
  );
}

export function diffStats(added: number, removed: number): HTMLElement {
  return el(
    'span',
    { class: 'stats', 'aria-label': `${added} lines added, ${removed} removed` },
    el('span', { class: 'add' }, `+${added}`),
    ' ',
    el('span', { class: 'del' }, `−${removed}`),
  );
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older webviews: copy through a hidden textarea.
    const area = el('textarea', { class: 'offscreen', 'aria-hidden': 'true' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
