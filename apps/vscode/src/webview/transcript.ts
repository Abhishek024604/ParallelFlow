// The transcript: keyed, incremental rendering. A row's node is reused while its key lives, updated
// in place only when its content changed (streaming text, a tool finishing), so nothing flickers
// and open <details> stay open. Scroll sticks to the bottom unless the person scrolled up; then a
// "Jump to latest" button shows.
import type { TranscriptItem } from '../pi/transcript.js';
import { el, icon } from './dom.js';
import { toRows, type Row } from './lib/tool-groups.js';
import { setMarkdown } from './markdown.js';
import { fillExplore, fillTool, toolSig } from './tools.js';

type Assistant = Extract<TranscriptItem, { kind: 'assistant' }>;

interface Rendered {
  node: HTMLElement;
  sig: string;
}

function rowSig(row: Row): string {
  if (row.kind === 'explore') return row.items.map(toolSig).join(',');
  const i = row.item;
  switch (i.kind) {
    case 'assistant':
      return `${i.streaming}|${i.text.length}|${i.thinking.length}|${i.text.slice(-32)}`;
    case 'tool':
      return toolSig(i);
    default:
      return `${i.text.length}|${i.text.slice(0, 32)}`;
  }
}

/** When each streamed thinking block started and ended, to show "Thought for 4s". */
const thinkingTimes = new Map<string, { start: number; end?: number }>();

function thinkingLabel(i: Assistant): string {
  const t = thinkingTimes.get(i.id);
  const thinkingNow = i.streaming && !i.text;
  if (i.streaming && i.thinking && !t) thinkingTimes.set(i.id, { start: Date.now() });
  const times = thinkingTimes.get(i.id);
  if (times && !times.end && !thinkingNow) times.end = Date.now();
  if (thinkingNow) return 'Thinking…';
  if (times?.end)
    return `Thought for ${Math.max(1, Math.round((times.end - times.start) / 1000))}s`;
  return 'Thought';
}

function fillAssistant(node: HTMLElement, i: Assistant, prev: string | undefined): void {
  node.className = `msg ai${i.streaming ? ' streaming' : ''}`;
  let thinking = node.querySelector<HTMLDetailsElement>(':scope > details.thinking');
  let body = node.querySelector<HTMLElement>(':scope > .md');
  if (i.thinking) {
    if (!thinking) {
      thinking = el(
        'details',
        { class: 'thinking' },
        el('summary', {}),
        el('div', { class: 'thinking-text' }),
      );
      node.prepend(thinking);
    }
    const summary = thinking.querySelector('summary');
    if (summary) summary.replaceChildren(icon('lightbulb'), ` ${thinkingLabel(i)}`);
    const text = thinking.querySelector('.thinking-text');
    if (text) text.textContent = i.thinking;
  }
  if (!body) {
    body = el('div', { class: 'md' });
    node.append(body);
  }
  if (prev !== i.text) setMarkdown(body, i.text);
  let caret = node.querySelector(':scope > .caret');
  if (i.streaming && !caret) {
    caret = el('span', { class: 'caret', 'aria-hidden': 'true' });
    node.append(caret);
  } else if (!i.streaming) caret?.remove();
}

const NOTICE_ICON = { info: 'info', warning: 'warning', error: 'error' } as const;

function create(row: Row): HTMLElement {
  if (row.kind === 'explore') return el('details', {});
  switch (row.item.kind) {
    case 'tool':
      return el('details', {});
    case 'user':
    case 'assistant':
    case 'notice':
      return el('div', {});
  }
}

function fill(node: HTMLElement, row: Row, texts: Map<string, string>): void {
  if (row.kind === 'explore') return fillExplore(node as HTMLDetailsElement, row.items);
  const i = row.item;
  switch (i.kind) {
    case 'tool':
      return fillTool(node as HTMLDetailsElement, i);
    case 'assistant':
      fillAssistant(node, i, texts.get(row.key));
      texts.set(row.key, i.text);
      return;
    case 'user':
      node.className = 'msg user';
      node.textContent = i.text;
      return;
    case 'notice':
      node.className = `notice ${i.level}`;
      node.replaceChildren(icon(NOTICE_ICON[i.level]), el('span', {}, i.text));
      return;
  }
}

export class TranscriptView {
  /** The scroll area: welcome, rows, then approvals. */
  readonly scroller = el('div', { class: 'scroller' });
  readonly welcome = el('div', { class: 'welcome-slot' });
  private readonly list = el('div', {
    class: 'rows',
    role: 'log',
    'aria-label': 'Chat with the agent',
    'aria-live': 'polite',
  });
  readonly after = el('div', { class: 'after-rows' });
  readonly jump = el(
    'button',
    { class: 'jump', type: 'button', 'aria-label': 'Jump to latest' },
    icon('arrow-down'),
    ' Jump to latest',
  );
  private readonly rendered = new Map<string, Rendered>();
  private readonly texts = new Map<string, string>();
  private stick = true;

  constructor() {
    this.scroller.append(this.welcome, this.list, this.after);
    this.jump.hidden = true;
    this.scroller.addEventListener('scroll', () => {
      const atBottom =
        this.scroller.scrollTop + this.scroller.clientHeight >= this.scroller.scrollHeight - 24;
      this.stick = atBottom;
      this.jump.hidden = atBottom;
    });
    this.jump.addEventListener('click', () => this.toBottom());
    // Content growing (images of code blocks, opened details) keeps the view pinned when stuck.
    const pin = new ResizeObserver(() => {
      if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    pin.observe(this.list);
    pin.observe(this.after);
  }

  get empty(): boolean {
    return this.rendered.size === 0;
  }

  toBottom(): void {
    this.stick = true;
    this.jump.hidden = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  render(items: readonly TranscriptItem[]): void {
    const rows = toRows(items);
    const live = new Set(rows.map((r) => r.key));
    for (const [key, r] of this.rendered) {
      if (!live.has(key)) {
        r.node.remove();
        this.rendered.delete(key);
        this.texts.delete(key);
      }
    }
    let prev: ChildNode | null = null;
    for (const row of rows) {
      const sig = rowSig(row);
      let r = this.rendered.get(row.key);
      if (!r) {
        r = { node: create(row), sig: '' };
        this.rendered.set(row.key, r);
      }
      if (r.sig !== sig) {
        fill(r.node, row, this.texts);
        r.sig = sig;
        r.node.dataset.key = row.key;
      }
      const want: ChildNode | null = prev ? prev.nextSibling : this.list.firstChild;
      if (want !== r.node) this.list.insertBefore(r.node, want);
      prev = r.node;
    }
    if (this.stick) this.scroller.scrollTop = this.scroller.scrollHeight;
  }
}
