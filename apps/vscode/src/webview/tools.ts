// Tool call rows: one compact line per call (codicon, verb, target, status), expandable in place.
// Explore runs (read/ls/find/grep) are one row; edits show +N −M, an inline diff and Open diff;
// bash is a terminal block. Each row keeps its <details> element across updates, so it stays open.
import { diffStats, el, icon, iconButton, pathLabel, send } from './dom.js';
import { statsOf } from '../shared/diff-stats.js';
import { exploreLabel, groupStatus, toolIcon, toolVerb, type ToolItem } from './lib/tool-groups.js';

export function statusIcon(status: ToolItem['status'], showOk = false): HTMLElement | null {
  if (status === 'running') {
    return el(
      'span',
      { class: 'tool-state running', role: 'img', 'aria-label': 'Running' },
      icon('loading', 'codicon-modifier-spin'),
    );
  }
  if (status === 'error') {
    return el(
      'span',
      { class: 'tool-state error', role: 'img', 'aria-label': 'Failed' },
      icon('error'),
    );
  }
  return showOk
    ? el('span', { class: 'tool-state ok', role: 'img', 'aria-label': 'Done' }, icon('check'))
    : null;
}

function diffView(diff: string): HTMLElement {
  return el(
    'pre',
    { class: 'diff' },
    ...diff
      .split('\n')
      .map((l) =>
        el(
          'span',
          { class: l.startsWith('+') ? 'line add' : l.startsWith('-') ? 'line del' : 'line' },
          `${l}\n`,
        ),
      ),
  );
}

function openPath(path: string): HTMLElement {
  const b = el(
    'button',
    { class: 'link-btn', type: 'button', title: `Open ${path}` },
    pathLabel(path),
  );
  b.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    send({ type: 'openFile', path });
  });
  return b;
}

export const toolSig = (i: ToolItem): string =>
  `${i.status}|${i.summary}|${i.output?.length ?? 0}|${i.diff?.length ?? 0}|${i.stats?.added ?? ''}`;

/** A single tool call row (anything but an explore run). */
export function fillTool(d: HTMLDetailsElement, i: ToolItem): void {
  const summary = el('summary', {});
  const body: Node[] = [];
  if (i.tool === 'edit' || i.tool === 'write') {
    d.className = 'tool edit';
    const s = statsOf(i);
    const open = iconButton('diff', `Open diff of ${i.summary}`, (e) => {
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'openDiff', path: i.summary });
    });
    summary.append(
      icon(toolIcon(i.tool), 'tool-icon'),
      el('span', { class: 'verb' }, toolVerb(i.tool)),
      pathLabel(i.summary),
      i.status === 'ok' || s.added || s.removed ? diffStats(s.added, s.removed) : '',
      statusIcon(i.status) ?? '',
      el('span', { class: 'row-actions' }, open),
    );
    if (i.diff) body.push(diffView(i.diff));
    else if (i.output) body.push(el('pre', { class: 'output' }, i.output));
  } else if (i.tool === 'bash') {
    d.className = `tool bash ${i.status}`;
    summary.append(
      icon('terminal', 'tool-icon'),
      el('code', { class: 'cmd' }, el('span', { class: 'prompt' }, '$ '), i.summary),
      statusIcon(i.status, true) ?? '',
    );
    body.push(
      el(
        'pre',
        { class: 'output term' },
        i.output || (i.status === 'running' ? 'Running…' : 'No output'),
      ),
    );
  } else {
    d.className = 'tool';
    summary.append(
      icon(toolIcon(i.tool), 'tool-icon'),
      el('span', { class: 'verb' }, toolVerb(i.tool)),
      el('span', { class: 'target' }, i.summary),
      statusIcon(i.status) ?? '',
    );
    if (i.output) body.push(el('pre', { class: 'output' }, i.output));
  }
  if (!body.length) d.classList.add('empty');
  d.replaceChildren(summary, ...body);
}

/** One row for a run of read/ls/find/grep calls. */
export function fillExplore(d: HTMLDetailsElement, items: ToolItem[]): void {
  d.className = 'tool explore';
  const status = groupStatus(items);
  const only = items.length === 1 ? items[0] : undefined;
  const summary = el(
    'summary',
    {},
    icon(only ? toolIcon(only.tool) : 'search', 'tool-icon'),
    only
      ? el(
          'span',
          {},
          el('span', { class: 'verb' }, toolVerb(only.tool)),
          ' ',
          el('span', { class: 'target' }, only.summary),
        )
      : el('span', { class: 'verb' }, exploreLabel(items)),
    statusIcon(status) ?? '',
  );
  const list = el(
    'ul',
    { class: 'explore-list' },
    ...items.map((i) =>
      el(
        'li',
        {},
        icon(toolIcon(i.tool)),
        el('span', { class: 'verb' }, toolVerb(i.tool)),
        i.tool === 'read' ? openPath(i.summary) : el('span', { class: 'target' }, i.summary),
        statusIcon(i.status) ?? '',
      ),
    ),
  );
  d.replaceChildren(summary, list);
}
