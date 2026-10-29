// The composer, docked at the bottom: context chips, an auto-growing box (Enter sends, Shift+Enter
// is a newline, IME safe), the / menu and the @ file picker, then mode, model and Send/Stop.
// Built once; render() only updates labels, so what the person types is never wiped.
import type { ViewState } from '../shared/messages.js';
import { command, el, icon, send } from './dom.js';
import { composerKey } from './lib/keys.js';
import { filterSlash, mentionAt, removeMention, slashQuery, type SlashItem } from './lib/menus.js';
import { Menu } from './menu.js';

export class Composer {
  readonly node = el('section', { class: 'composer', 'aria-label': 'Message the agent' });
  private readonly box = el('textarea', {
    rows: '1',
    'aria-label': 'Message the agent',
    'aria-autocomplete': 'list',
  });
  private readonly chipRow = el('div', {
    class: 'chips context-chips',
    'aria-label': 'Context files',
  });
  private readonly menu = new Menu('Suggestions', this.box);
  private readonly modeBtn = el('button', {
    class: 'mode-btn',
    type: 'button',
    'aria-haspopup': 'menu',
  });
  private readonly modeMenu = new Menu('Mode');
  private readonly modelLabel = el('span', { class: 'model muted', title: 'Model' });
  private readonly sendBtn = el('button', { class: 'send-btn', type: 'button' });
  private chips: string[] = [];
  private state: ViewState | undefined;
  private searchId = 0;
  private searchTimer: number | undefined;
  private menuKind: 'slash' | 'file' | undefined;

  constructor() {
    this.box.addEventListener('input', () => {
      this.grow();
      this.updateMenu();
      this.updateSend();
    });
    this.box.addEventListener('click', () => this.updateMenu());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    this.box.addEventListener('blur', () => this.menu.close());
    this.sendBtn.addEventListener('click', () => {
      if (this.isStop()) command('stopAgent')();
      else this.submit();
    });
    this.modeMenu.node.classList.add('mode-menu');
    this.modeBtn.addEventListener('click', () => this.openModeMenu());
    const field = el('div', { class: 'field' }, this.chipRow, this.box);
    field.addEventListener('click', (e) => {
      if (e.target === field) this.box.focus();
    });
    this.node.append(
      this.menu.node,
      this.modeMenu.node,
      field,
      el(
        'div',
        { class: 'composer-bar' },
        this.modeBtn,
        this.modelLabel,
        el('span', { class: 'spacer' }),
        this.sendBtn,
      ),
    );
    this.drawChips();
  }

  focus(): void {
    this.box.focus();
  }

  addChip(chip: string): void {
    if (!this.chips.includes(chip)) this.chips.push(chip);
    this.drawChips();
    this.box.focus();
  }

  /** Fills the box (suggestion chips, slash items with arguments). */
  fill(text: string): void {
    this.box.value = text;
    this.grow();
    this.box.focus();
    this.box.setSelectionRange(text.length, text.length);
    this.updateSend();
  }

  /** Sends a prompt as if typed, with the current chips. */
  sendText(text: string): void {
    send({ type: 'prompt', text, ...(this.chips.length && { context: [...this.chips] }) });
    this.chips = [];
    this.drawChips();
  }

  fileResults(requestId: number, files: string[]): void {
    if (requestId !== this.searchId || this.menuKind !== 'file') return;
    const mention = mentionAt(this.box.value, this.box.selectionStart);
    if (!mention) return;
    this.menu.open(
      files.map((f) => ({
        label: f.slice(f.lastIndexOf('/') + 1),
        detail: f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '',
        icon: 'file',
        run: () => {
          const next = removeMention(this.box.value, mention);
          this.box.value = next.text;
          this.box.setSelectionRange(next.caret, next.caret);
          this.addChip(f);
          this.grow();
        },
      })),
      () => (this.menuKind = undefined),
    );
  }

  render(s: ViewState): void {
    this.state = s;
    this.node.hidden = !s.signedIn || !s.folder;
    this.box.placeholder = s.task
      ? 'Message the agent about this task. / for commands, @ for files'
      : 'Ask the agent to build or change something. / for commands, @ for files';
    this.modeBtn.replaceChildren(
      icon(s.mode === 'architect' ? 'symbol-structure' : 'code'),
      ` ${s.mode === 'architect' ? 'Architect' : 'Coder'} `,
      icon('chevron-down'),
    );
    this.modeBtn.setAttribute(
      'aria-label',
      `Mode: ${s.mode === 'architect' ? 'Architect' : 'Coder'}. Change mode`,
    );
    this.modelLabel.textContent = s.agent.model ?? '';
    this.updateSend();
  }

  private isStop(): boolean {
    const busy = this.state?.agent.status === 'working' || this.state?.agent.status === 'waiting';
    return busy && this.box.value.trim() === '';
  }

  private updateSend(): void {
    const stop = this.isStop();
    this.sendBtn.replaceChildren(icon(stop ? 'debug-stop' : 'send'));
    this.sendBtn.className = `send-btn${stop ? ' stop' : ''}`;
    const label = stop ? 'Stop the agent' : 'Send (Enter)';
    this.sendBtn.setAttribute('aria-label', label);
    this.sendBtn.title = label;
    this.sendBtn.disabled = !stop && this.box.value.trim() === '' && this.chips.length === 0;
  }

  private grow(): void {
    this.box.style.height = 'auto';
    this.box.style.height = `${Math.min(this.box.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }

  private submit(): void {
    const text = this.box.value.trim();
    if (!text && !this.chips.length) return;
    this.sendText(text || 'Look at these files.');
    this.box.value = '';
    this.grow();
    this.menu.close();
    this.updateSend();
  }

  private onKey(e: KeyboardEvent): void {
    if (this.menu.key(e)) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Backspace' && this.box.value === '' && this.chips.length) {
      this.chips.pop();
      this.drawChips();
      return;
    }
    if (composerKey(e) === 'send') {
      e.preventDefault();
      this.submit();
    }
  }

  private runSlash(item: SlashItem): void {
    const a = item.action;
    if (a.kind === 'command') {
      this.box.value = '';
      this.grow();
      this.updateSend();
      command(a.command)();
    } else if (a.kind === 'send') {
      this.box.value = '';
      this.grow();
      this.sendText(a.text);
      this.updateSend();
    } else this.fill(a.text);
  }

  private updateMenu(): void {
    const text = this.box.value;
    const q = slashQuery(text);
    if (q !== undefined && !q.endsWith(' ')) {
      const items = filterSlash(q);
      if (this.menuKind !== 'slash') this.menu.reset();
      this.menuKind = 'slash';
      this.menu.open(
        items.map((item) => ({
          label: item.label,
          detail: item.detail,
          icon: item.icon,
          run: () => this.runSlash(item),
        })),
        () => (this.menuKind = undefined),
      );
      return;
    }
    const mention = this.state?.folder ? mentionAt(text, this.box.selectionStart) : undefined;
    if (mention) {
      if (this.menuKind !== 'file') this.menu.reset();
      this.menuKind = 'file';
      window.clearTimeout(this.searchTimer);
      const requestId = ++this.searchId;
      this.searchTimer = window.setTimeout(
        () => send({ type: 'fileSearch', requestId, query: mention.query }),
        100,
      );
      return;
    }
    this.menu.close();
  }

  private openModeMenu(): void {
    const s = this.state;
    if (!s) return;
    const entry = (mode: ViewState['mode'], label: string, detail: string) => ({
      label: `${s.mode === mode ? '✓ ' : ''}${label}`,
      detail,
      icon: mode === 'architect' ? 'symbol-structure' : 'code',
      run: () => {
        if (s.mode !== mode) command('switchMode')();
        this.modeBtn.focus();
      },
    });
    this.modeMenu.open([
      entry('coder', 'Coder', 'Writes and reviews code for arena tasks'),
      entry('architect', 'Architect', 'Architecture first, with SWA approval gates'),
    ]);
  }

  private drawChips(): void {
    this.chipRow.hidden = this.chips.length === 0;
    this.chipRow.replaceChildren(
      ...this.chips.map((c) => {
        const remove = el(
          'button',
          { type: 'button', class: 'chip-x', 'aria-label': `Remove ${c}`, title: 'Remove' },
          icon('close'),
        );
        remove.addEventListener('click', () => {
          this.chips = this.chips.filter((x) => x !== c);
          this.drawChips();
          this.box.focus();
        });
        const open = el(
          'button',
          { type: 'button', class: 'chip-label', title: `Open ${c}` },
          icon(c.includes(':L') ? 'selection' : 'file'),
          ` ${c}`,
        );
        open.addEventListener('click', () => send({ type: 'openFile', path: c }));
        return el('span', { class: 'chip' }, open, remove);
      }),
    );
    this.updateSend();
  }
}
