// A popup list for the / and @ menus (focus stays in the composer, which forwards keys) and for
// the header's overflow and mode menus (the list takes focus). Arrow keys, Enter/Tab, Escape.
import { el, icon } from './dom.js';
import { menuKey, moveIndex } from './lib/keys.js';

export interface MenuEntry {
  label: string;
  detail?: string;
  icon?: string;
  run(): void;
}

let menuIds = 0;

export class Menu {
  readonly node: HTMLElement;
  private entries: MenuEntry[] = [];
  private active = 0;
  private readonly id = `menu${++menuIds}`;
  private onClose: (() => void) | undefined;

  /** `owner`: the element that keeps focus (the composer); without one the list takes focus. */
  constructor(
    label: string,
    private readonly owner?: HTMLElement,
  ) {
    this.node = el('ul', {
      class: 'menu',
      id: this.id,
      role: owner ? 'listbox' : 'menu',
      'aria-label': label,
      tabindex: '-1',
    });
    this.node.hidden = true;
    this.node.addEventListener('mousedown', (e) => e.preventDefault()); // keep the owner's focus
    if (!owner) {
      this.node.addEventListener('keydown', (e) => {
        if (this.key(e)) e.preventDefault();
      });
      this.node.addEventListener('focusout', (e) => {
        if (!this.node.contains(e.relatedTarget as Node | null)) this.close();
      });
    }
  }

  get isOpen(): boolean {
    return !this.node.hidden;
  }

  open(entries: MenuEntry[], onClose?: () => void): void {
    this.entries = entries;
    this.onClose = onClose;
    if (this.active >= entries.length) this.active = 0;
    this.node.hidden = entries.length === 0;
    this.draw();
    if (!this.owner && entries.length) this.node.focus();
  }

  /** Re-opening with a new filter starts at the top. */
  reset(): void {
    this.active = 0;
  }

  close(): void {
    if (this.node.hidden) return;
    this.node.hidden = true;
    this.owner?.removeAttribute('aria-activedescendant');
    const done = this.onClose;
    this.onClose = undefined;
    done?.();
  }

  /** Handles a navigation key; true when it was used. */
  key(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    const action = menuKey(e);
    if (!action) return false;
    if (action === 'close') this.close();
    else if (action === 'pick') this.pick(this.active);
    else {
      this.active = moveIndex(this.active, action === 'up' ? -1 : 1, this.entries.length);
      this.draw();
    }
    return true;
  }

  private pick(i: number): void {
    const entry = this.entries[i];
    this.close();
    entry?.run();
  }

  private draw(): void {
    this.node.replaceChildren(
      ...this.entries.map((entry, i) => {
        const li = el(
          'li',
          {
            id: `${this.id}-${i}`,
            role: this.owner ? 'option' : 'menuitem',
            class: i === this.active ? 'active' : '',
            'aria-selected': String(i === this.active),
          },
          entry.icon ? icon(entry.icon) : null,
          el('span', { class: 'menu-label' }, entry.label),
          entry.detail ? el('span', { class: 'menu-detail' }, entry.detail) : null,
        );
        li.addEventListener('click', () => this.pick(i));
        li.addEventListener('mousemove', () => {
          if (this.active === i) return;
          this.active = i;
          this.draw();
        });
        return li;
      }),
    );
    const current = this.node.children[this.active] as HTMLElement | undefined;
    current?.scrollIntoView({ block: 'nearest' });
    if (this.owner && current) this.owner.setAttribute('aria-activedescendant', current.id);
  }
}
