// First run and empty chat: sign in (with the device code), link or start an arena, or suggestion
// chips that send a first prompt.
import type { ViewState } from '../shared/messages.js';
import { button, command, el, icon, send } from './dom.js';

export interface WelcomeActions {
  prompt(text: string): void;
}

function suggestion(label: string, ic: string, run: () => void): HTMLElement {
  return button(label, run, 'secondary', { icon: ic });
}

export function renderWelcome(
  slot: HTMLElement,
  s: ViewState,
  hasItems: boolean,
  actions: WelcomeActions,
): void {
  slot.replaceChildren();
  slot.hidden = s.signedIn && hasItems;
  if (slot.hidden) return;
  const hero = el(
    'div',
    { class: 'welcome' },
    el('div', { class: 'welcome-mark', 'aria-hidden': 'true' }, icon('sparkle')),
  );
  slot.append(hero);

  if (!s.signedIn) {
    hero.append(
      el('h2', {}, 'ParallelFlow'),
      el(
        'p',
        { class: 'muted' },
        'Code your arena’s tasks with an AI agent that works on its own branch, in this folder, and asks before it runs commands.',
      ),
    );
    if (s.signIn) {
      const link = el('a', { href: '#' }, 'Open the sign-in page');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        send({ type: 'openUrl', url: s.signIn?.uri ?? '' });
      });
      hero.append(
        el('p', {}, 'Confirm this code in the browser:'),
        el(
          'p',
          { class: 'code', 'aria-label': `Code ${s.signIn.userCode.split('').join(' ')}` },
          s.signIn.userCode,
        ),
        el('p', {}, link),
        button('Cancel', command('cancelSignIn'), 'secondary'),
      );
    } else {
      hero.append(
        button('Sign in', command('signIn'), 'primary', { icon: 'account' }),
        el('p', { class: 'muted small' }, `Signs in to ${s.parallelflowUrl}`),
      );
    }
    return;
  }

  if (!s.folder) {
    hero.append(
      el('h2', {}, 'Open a folder'),
      el(
        'p',
        { class: 'muted' },
        'The agent works inside one folder. Open one, or start building an arena in a new folder.',
      ),
      el(
        'div',
        { class: 'suggestions' },
        button('Start building', command('startBuilding'), 'primary', { icon: 'rocket' }),
      ),
    );
    return;
  }

  if (!s.arena) {
    hero.append(
      el('h2', {}, 'What should we build?'),
      el(
        'p',
        { class: 'muted' },
        'This folder is not linked to an arena. Link it to code your arena’s stories here, or just ask the agent below.',
      ),
      el(
        'div',
        { class: 'suggestions' },
        button('Start building', command('startBuilding'), 'primary', { icon: 'rocket' }),
        button('Link arena', command('linkArena'), 'secondary', { icon: 'link' }),
      ),
    );
  } else {
    hero.append(
      el('h2', {}, s.arena.name),
      el(
        'p',
        { class: 'muted' },
        'Pick a story and the agent builds it on its own branch. Edits show as diffs here; commands ask you first.',
      ),
    );
  }
  const chips = el('div', { class: 'suggestions' });
  if (s.arena) chips.append(suggestion('Pick a story to build', 'tasklist', command('startTask')));
  chips.append(
    suggestion('Explain this repo', 'book', () =>
      actions.prompt(
        'Explain this repository: what it does, how it is laid out, and how to build, run and test it.',
      ),
    ),
    suggestion('Run the tests', 'beaker', () =>
      actions.prompt('Run the project’s tests and summarise what passes and what fails.'),
    ),
  );
  if (s.mode === 'architect')
    chips.append(
      suggestion('Architecture status', 'symbol-structure', () => actions.prompt('/swa status')),
    );
  hero.append(chips);
  if (s.mode === 'architect' || s.architecture?.gates.some((g) => g.state !== 'empty')) {
    hero.append(
      el(
        'p',
        { class: 'muted small' },
        icon('info'),
        ' Architecture gates and files are in the Arena view.',
      ),
    );
  }
  if (s.history.length) {
    hero.append(
      el(
        'details',
        { class: 'history' },
        el('summary', {}, `Earlier tasks (${s.history.length})`),
        el(
          'ul',
          {},
          ...s.history.map((h) =>
            el('li', {}, `${h.title} — ${h.branch}${h.pr ? ` · PR #${h.pr}` : ''}`),
          ),
        ),
      ),
    );
  }
}
