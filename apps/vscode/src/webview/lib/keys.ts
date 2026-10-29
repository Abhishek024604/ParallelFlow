// Keyboard mapping for the chat: composer Enter/Shift+Enter, menus, and the 1/2/3 approval keys.
// Pure, so the rules are tested without a DOM.
import type { ApprovalKind } from '../../approvals/broker.js';

export type ApprovalChoice = 'approve' | 'approve_session' | 'deny';

/** The buttons of an approval card in order; key N picks the Nth. */
export function approvalChoices(kind: ApprovalKind): ApprovalChoice[] {
  return kind === 'command' ? ['approve', 'approve_session', 'deny'] : ['approve', 'deny'];
}

export function approvalKey(key: string, kind: ApprovalKind): ApprovalChoice | undefined {
  if (kind === 'question') return undefined;
  if (!/^[1-9]$/.test(key)) return undefined;
  return approvalChoices(kind)[Number(key) - 1];
}

/** Index of the question option key N picks, if there is one. */
export function questionKey(key: string, options: number): number | undefined {
  if (!/^[1-9]$/.test(key)) return undefined;
  const i = Number(key) - 1;
  return i < options ? i : undefined;
}

export interface KeyLike {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** Enter sends, Shift+Enter is a newline, and nothing fires while an IME is composing. */
export function composerKey(e: KeyLike): 'send' | 'newline' | undefined {
  if (e.key !== 'Enter') return undefined;
  if (e.isComposing || e.keyCode === 229) return undefined;
  if (e.shiftKey || e.altKey) return 'newline';
  return 'send';
}

export type MenuAction = 'up' | 'down' | 'pick' | 'close';

export function menuKey(e: KeyLike): MenuAction | undefined {
  if (e.isComposing) return undefined;
  switch (e.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'Enter':
    case 'Tab':
      return e.shiftKey ? undefined : 'pick';
    case 'Escape':
      return 'close';
    default:
      return undefined;
  }
}

/** Wraps around a list of n items. */
export function moveIndex(i: number, delta: number, n: number): number {
  if (n <= 0) return 0;
  return (((i + delta) % n) + n) % n;
}

/** Number keys must not fire approvals while the person types in a field. */
export function isTypingTarget(tag: string | undefined, editable = false): boolean {
  const t = (tag ?? '').toUpperCase();
  return editable || t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT';
}
