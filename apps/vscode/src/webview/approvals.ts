// Approvals and questions, inline at the end of the transcript. Commands: [1 Allow] [2 Allow for
// this session] [3 Deny]; edits and confirms: [1 Allow] [2 Deny]. Deny opens an optional reason.
// Questions: options as chips, an own answer, and Skip. Number keys work when focus is not in a
// text field. Cards are built once per request, so typed reasons survive state updates.
import type { ApprovalRequest } from '../approvals/broker.js';
import { button, el, icon, send } from './dom.js';
import { type ApprovalChoice, approvalChoices, approvalKey, questionKey } from './lib/keys.js';

const LABEL: Record<ApprovalChoice, string> = {
  approve: 'Allow',
  approve_session: 'Allow for this session',
  deny: 'Deny',
};

const TITLE: Record<ApprovalRequest['kind'], string> = {
  command: 'Allow this command?',
  edit: 'Allow this edit?',
  confirm: 'Allow this?',
  question: 'The agent asks',
};

interface Card {
  node: HTMLElement;
  /** Handles a number key; true when it did something. */
  key(k: string): boolean;
  hint: HTMLElement;
  expiresAt: number;
}

function expiryText(expiresAt: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
  return seconds < 60
    ? `Denied automatically in ${seconds}s`
    : `Denied automatically in ${Math.ceil(seconds / 60)} min`;
}

function decisionCard(a: ApprovalRequest): Card {
  const node = el('div', {
    class: `approval ${a.kind}`,
    role: 'group',
    'aria-label': TITLE[a.kind],
    tabindex: '-1',
  });
  const head = el(
    'div',
    { class: 'approval-title' },
    icon(a.kind === 'command' ? 'terminal' : a.kind === 'edit' ? 'edit' : 'shield'),
    TITLE[a.kind],
  );
  node.append(head);
  if (a.kind === 'command') {
    node.append(el('pre', { class: 'command' }, el('span', { class: 'prompt' }, '$ '), a.detail));
    if (a.cwd) node.append(el('div', { class: 'muted small' }, `in ${a.cwd}`));
  } else if (a.kind === 'edit') {
    node.append(el('pre', { class: 'command' }, a.detail));
  } else node.append(el('p', {}, a.detail));
  if (a.reason) node.append(el('div', { class: 'muted small' }, a.reason));

  const reason = el('input', {
    type: 'text',
    class: 'reason',
    placeholder: 'Tell the agent why, or what to do instead (optional). Enter to deny.',
    'aria-label': 'Reason for denying',
  });
  const reasonRow = el('div', { class: 'reason-row' }, reason);
  reasonRow.hidden = true;
  const deny = () =>
    send({
      type: 'decision',
      id: a.id,
      decision: 'deny',
      reason: reason.value.trim() || undefined,
    });
  reason.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      deny();
    } else if (e.key === 'Escape') {
      reasonRow.hidden = true;
      node.focus();
    }
  });
  reasonRow.append(button('Deny', deny, 'secondary'));

  const choose = (c: ApprovalChoice) => {
    if (c === 'deny') {
      if (reasonRow.hidden) {
        reasonRow.hidden = false;
        reason.focus();
      } else deny();
      return;
    }
    send({ type: 'decision', id: a.id, decision: c });
  };
  const choices = approvalChoices(a.kind);
  const row = el(
    'div',
    { class: 'choices' },
    ...choices.map((c, n) =>
      button(
        el('span', {}, el('kbd', {}, String(n + 1)), ` ${LABEL[c]}`),
        () => choose(c),
        c === 'approve' ? 'primary' : 'secondary',
        { title: `${LABEL[c]} (${n + 1})` },
      ),
    ),
  );
  const hint = el('div', { class: 'expiry' }, expiryText(a.expiresAt));
  node.append(row, reasonRow, hint);
  return {
    node,
    hint,
    expiresAt: a.expiresAt,
    key: (k) => {
      const c = approvalKey(k, a.kind);
      if (!c) return false;
      choose(c);
      return true;
    },
  };
}

function questionCard(a: ApprovalRequest): Card {
  const node = el('div', {
    class: 'approval question',
    role: 'group',
    'aria-label': 'Question from the agent',
    tabindex: '-1',
  });
  const options = a.options ?? [];
  const answer = (text: string) => send({ type: 'answer', id: a.id, answer: text });
  const own = el('input', {
    type: 'text',
    placeholder: 'Or type your own answer',
    'aria-label': 'Your answer',
  });
  own.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && own.value.trim()) {
      e.preventDefault();
      answer(own.value.trim());
    }
  });
  const hint = el('div', { class: 'expiry' }, expiryText(a.expiresAt));
  node.append(
    el('div', { class: 'approval-title' }, icon('comment-discussion'), TITLE.question),
    el('p', { class: 'question-text' }, a.detail),
    options.length
      ? el(
          'div',
          { class: 'chips' },
          ...options.map((o, n) =>
            button(
              el('span', {}, n < 9 ? el('kbd', {}, String(n + 1)) : '', ` ${o}`),
              () => answer(o),
              'secondary',
            ),
          ),
        )
      : '',
    el(
      'div',
      { class: 'own-answer' },
      own,
      button('Skip', () => send({ type: 'decision', id: a.id, decision: 'deny' }), 'ghost'),
    ),
    hint,
  );
  return {
    node,
    hint,
    expiresAt: a.expiresAt,
    key: (k) => {
      const i = questionKey(k, options.length);
      const o = i === undefined ? undefined : options[i];
      if (o === undefined) return false;
      answer(o);
      return true;
    },
  };
}

export class ApprovalsView {
  readonly node = el('div', { class: 'approvals', 'aria-live': 'assertive' });
  private readonly cards = new Map<string, Card>();
  private order: string[] = [];

  constructor() {
    // The expiry hint counts down quietly.
    setInterval(() => {
      for (const c of this.cards.values()) c.hint.textContent = expiryText(c.expiresAt);
    }, 15_000);
  }

  get count(): number {
    return this.order.length;
  }

  render(list: readonly ApprovalRequest[]): boolean {
    const ids = list.map((a) => a.id);
    let added = false;
    for (const id of [...this.cards.keys()]) {
      if (!ids.includes(id)) {
        this.cards.get(id)?.node.remove();
        this.cards.delete(id);
      }
    }
    for (const a of list) {
      if (this.cards.has(a.id)) continue;
      const card = a.kind === 'question' ? questionCard(a) : decisionCard(a);
      this.cards.set(a.id, card);
      this.node.append(card.node);
      added = true;
    }
    this.order = ids;
    return added;
  }

  /** A number key: for the card that has focus, else the first open request. */
  key(k: string, target: EventTarget | null): boolean {
    for (const id of this.order) {
      const card = this.cards.get(id);
      if (card && target instanceof Node && card.node.contains(target)) return card.key(k);
    }
    const first = this.order[0];
    return first ? (this.cards.get(first)?.key(k) ?? false) : false;
  }
}
