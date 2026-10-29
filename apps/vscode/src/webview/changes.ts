// Above the composer: the task strip (story, branch, push and pull request actions) and the
// changes bar ("3 files changed +40 −7", Review lists each file with Open diff). Changes come from
// this chat's successful edit and write calls.
import { changedFiles, totalStats } from '../shared/diff-stats.js';
import type { ViewState } from '../shared/messages.js';
import {
  button,
  command,
  diffStats,
  el,
  icon,
  iconButton,
  pathLabel,
  send,
  urlLink,
} from './dom.js';

export class TaskStrip {
  readonly node = el('div', { class: 'task-strip', role: 'region', 'aria-label': 'Task' });

  render(s: ViewState): void {
    const t = s.task;
    this.node.hidden = !s.signedIn || !t;
    if (!t) return;
    const busy = s.agent.status === 'working';
    const actions = el('div', { class: 'task-actions' });
    if (t.github) {
      // GitHub: the extension runs the checks, pushes and opens (or updates) the PR on GitHub.
      if (t.pr) actions.append(urlLink(`PR #${t.pr.number}`, t.pr.link));
      actions.append(
        button(
          t.pr ? 'Update pull request' : 'Open pull request',
          command('openPr'),
          t.pr ? 'secondary' : 'primary',
          {
            disabled: busy,
            icon: 'git-pull-request',
          },
        ),
      );
    } else {
      actions.append(
        button(
          t.pushed ? 'Push again' : 'Push branch',
          command('pushBranch'),
          t.pushed ? 'secondary' : 'primary',
          {
            disabled: busy,
            icon: 'cloud-upload',
          },
        ),
      );
      actions.append(
        t.pr
          ? urlLink(`PR #${t.pr.number}`, t.pr.link)
          : button('Open PR', command('openPr'), 'secondary', {
              disabled: !t.pushed,
              icon: 'git-pull-request',
            }),
      );
    }
    this.node.replaceChildren(
      el(
        'div',
        { class: 'task-info' },
        icon('tasklist'),
        el('span', { class: 'task-title', title: t.title }, t.title),
        el(
          'span',
          { class: 'muted task-branch', title: t.branch },
          icon('git-branch'),
          ` ${t.branch}`,
        ),
      ),
      actions,
    );
  }
}

export class ChangesBar {
  readonly node = el('div', { class: 'changes', role: 'region', 'aria-label': 'Changed files' });
  private readonly list = el('ul', { class: 'changes-list' });
  private readonly head = el('div', { class: 'changes-head' });
  private sig = '';
  private expanded = false;
  private last: ViewState | undefined;

  constructor() {
    this.node.append(this.head, this.list);
  }

  render(s: ViewState): void {
    this.last = s;
    const files = changedFiles(s.transcript);
    this.node.hidden = !s.signedIn || files.length === 0;
    const sig = `${this.expanded}|${files.map((f) => `${f.path}:${f.added}:${f.removed}`).join(',')}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const total = totalStats(files);
    const toggle = button(
      this.expanded ? 'Hide' : 'Review',
      () => {
        this.expanded = !this.expanded;
        if (this.last) this.render(this.last);
      },
      'ghost',
      { icon: this.expanded ? 'chevron-down' : 'chevron-up' },
    );
    toggle.setAttribute('aria-expanded', String(this.expanded));
    this.head.replaceChildren(
      icon('diff-multiple'),
      el('span', {}, `${files.length} file${files.length === 1 ? '' : 's'} changed`),
      diffStats(total.added, total.removed),
      el('span', { class: 'spacer' }),
      toggle,
    );
    this.list.hidden = !this.expanded;
    this.list.replaceChildren(
      ...files.map((f) => {
        const open = el(
          'button',
          { type: 'button', class: 'link-btn', title: `Open diff of ${f.path}` },
          pathLabel(f.path),
        );
        open.addEventListener('click', () => send({ type: 'openDiff', path: f.path }));
        return el(
          'li',
          {},
          open,
          diffStats(f.added, f.removed),
          iconButton('go-to-file', `Open ${f.path}`, () =>
            send({ type: 'openFile', path: f.path }),
          ),
        );
      }),
    );
  }
}
