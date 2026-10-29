// Compact header: arena · stage, the task branch, agent status and model, then New chat, History
// and an overflow menu with the rarely used actions. Notices (isolation, agent errors) sit below.
import type { HostCommand, ViewState } from '../shared/messages.js';
import { button, command, el, icon, iconButton } from './dom.js';
import { Menu, type MenuEntry } from './menu.js';

const STATUS_LABEL: Record<ViewState['agent']['status'], string> = {
  off: 'Agent off',
  starting: 'Starting',
  idle: 'Ready',
  working: 'Working',
  waiting: 'Needs you',
  error: 'Error',
};

export class Header {
  readonly node = el('header', { class: 'header' });
  private readonly title = el('div', { class: 'title' });
  private readonly status = el('span', { class: 'status', role: 'status' });
  private readonly notices = el('div', { class: 'header-notices' });
  private readonly overflow = new Menu('More actions');
  private readonly more = iconButton('ellipsis', 'More actions', () => this.openOverflow());
  private state: ViewState | undefined;

  constructor() {
    this.more.setAttribute('aria-haspopup', 'menu');
    const actions = el(
      'div',
      { class: 'header-actions' },
      iconButton('add', 'New chat', command('newChat')),
      iconButton('history', 'Earlier chats', command('resumeChat')),
      this.more,
    );
    this.node.append(
      el('div', { class: 'header-row' }, this.title, actions),
      this.overflow.node,
      this.notices,
    );
  }

  render(s: ViewState): void {
    this.state = s;
    this.node.hidden = !s.signedIn;
    if (!s.signedIn) return;
    const arena = s.arena
      ? el(
          'span',
          { class: 'arena-name', title: s.arena.name },
          el('strong', {}, s.arena.name),
          s.arena.stage ? el('span', { class: 'muted' }, ` · ${s.arena.stage}`) : null,
        )
      : el('span', { class: 'arena-name muted' }, 'No arena linked');
    const branch = s.task
      ? el(
          'span',
          { class: 'branch-chip', title: `Branch ${s.task.branch}` },
          icon('git-branch'),
          ` ${s.task.branch}`,
        )
      : null;
    const iso =
      s.isolation === 'container'
        ? el(
            'span',
            {
              class: 'iso ok',
              title: 'Pi and its commands run inside the Dev Container',
              role: 'img',
              'aria-label': 'Isolated in a Dev Container',
            },
            icon('shield'),
          )
        : el(
            'span',
            {
              class: 'iso warn',
              title: 'Shell commands run on this computer and need approval',
              role: 'img',
              'aria-label': 'Runs on this computer',
            },
            icon('unlock'),
          );
    this.status.className = `status ${s.agent.status}`;
    this.status.title = `${STATUS_LABEL[s.agent.status]}${s.agent.model ? ` · ${s.agent.model}` : ''}`;
    this.status.replaceChildren(
      el('span', { class: 'dot', 'aria-hidden': 'true' }),
      ` ${STATUS_LABEL[s.agent.status]}`,
    );
    this.title.replaceChildren(
      arena,
      branch ?? '',
      el('span', { class: 'title-meta' }, this.status, iso),
    );

    this.notices.replaceChildren();
    if (s.agent.error) {
      this.notices.append(
        el(
          'div',
          { class: 'banner error', role: 'alert' },
          icon('error'),
          el('span', {}, s.agent.error),
        ),
      );
    }
    if (s.isolation === 'host-container-available') {
      this.notices.append(
        el(
          'div',
          { class: 'banner' },
          icon('info'),
          el(
            'span',
            {},
            'This folder has a Dev Container. Reopen it there so the agent runs isolated.',
          ),
          button('Reopen', command('reopenInContainer'), 'ghost'),
        ),
      );
    }
  }

  private openOverflow(): void {
    const s = this.state;
    if (!s) return;
    const e = (label: string, ic: string, c: HostCommand): MenuEntry => ({
      label,
      icon: ic,
      run: command(c),
    });
    const entries: MenuEntry[] = [
      e('Start task', 'tasklist', 'startTask'),
      e('Open chat in editor tab', 'link-external', 'openChatTab'),
      e(
        s.mode === 'architect' ? 'Switch to Coder mode' : 'Switch to Architect mode',
        'arrow-swap',
        'switchMode',
      ),
      e('Start building in a new folder', 'rocket', 'startBuilding'),
      e(s.arena ? 'Link to another arena' : 'Link this folder to an arena', 'link', 'linkArena'),
    ];
    if (s.arena) entries.push(e('Unlink this folder', 'debug-disconnect', 'unlinkArena'));
    if (s.arena && !s.githubRepo)
      entries.push(e('Clone arena repo', 'repo-clone', 'cloneArenaRepo'));
    if (s.isolation === 'host-container-available')
      entries.push(e('Reopen in Dev Container', 'remote', 'reopenInContainer'));
    else if (s.isolation === 'host')
      entries.push(e('Add a Dev Container', 'remote', 'scaffoldDevContainer'));
    entries.push(e('Refresh architecture summary', 'refresh', 'refreshArchitecture'));
    if (s.agent.status !== 'off')
      entries.push(e('Restart the agent', 'debug-restart', 'restartAgent'));
    entries.push(e('Sign out', 'sign-out', 'signOut'));
    this.overflow.reset();
    this.overflow.open(entries, () => this.more.focus());
  }
}
