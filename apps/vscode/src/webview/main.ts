// Sidebar webview. Plain DOM, text only (never innerHTML with data). Inputs live in containers
// that are built once, so re-rendering state never wipes what the person is typing.
import type { ApprovalRequest } from '../approvals/broker.js';
import type { TranscriptItem } from '../pi/transcript.js';
import type { FromWebview, HostCommand, ToWebview, ViewState } from '../shared/messages.js';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void };
const vscode = acquireVsCodeApi();
const send = (m: FromWebview) => vscode.postMessage(m);

type Child = Node | string | null | undefined | false;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
}

function button(
  label: string,
  onClick: () => void,
  kind: 'primary' | 'secondary' = 'secondary',
  disabled = false,
) {
  const b = el('button', { class: `btn ${kind}`, type: 'button' }, label);
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

const command = (c: HostCommand) => () => send({ type: 'command', command: c });

const app = document.getElementById('app') as HTMLElement;
const header = el('section', { class: 'header' });
const approvals = el('section', { class: 'approvals' });
const transcript = el('section', { class: 'transcript', 'aria-label': 'Agent transcript' });

// Task form and prompt box: built once.
const taskTitle = el('input', {
  type: 'text',
  placeholder: 'Task title',
  'aria-label': 'Task title',
});
const taskDesc = el('textarea', {
  rows: '3',
  placeholder: 'What should the agent do?',
  'aria-label': 'Task description',
});
const taskForm = el(
  'form',
  { class: 'task-form' },
  taskTitle,
  taskDesc,
  el('div', { class: 'row' }),
);
const startButton = button(
  'Start task',
  () => {
    const title = taskTitle.value.trim();
    if (!title) {
      taskTitle.focus();
      return;
    }
    send({ type: 'startTask', title, description: taskDesc.value.trim() });
    taskTitle.value = '';
    taskDesc.value = '';
  },
  'primary',
);
taskForm.querySelector('.row')?.append(startButton);
taskForm.addEventListener('submit', (e) => e.preventDefault());

const promptBox = el('textarea', {
  rows: '2',
  placeholder: 'Message the agent (Ctrl+Enter to send)',
  'aria-label': 'Message the agent',
});
const sendPrompt = () => {
  const text = promptBox.value.trim();
  if (!text) return;
  send({ type: 'prompt', text });
  promptBox.value = '';
};
promptBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendPrompt();
  }
});
const composer = el(
  'section',
  { class: 'composer' },
  promptBox,
  el('div', { class: 'row' }, button('Send', sendPrompt)),
);
const taskSection = el('section', { class: 'task' });

app.append(header, approvals, taskSection, taskForm, transcript, composer);

const STATUS_LABEL: Record<ViewState['agent']['status'], string> = {
  off: 'Agent off',
  starting: 'Starting…',
  idle: 'Ready',
  working: 'Working…',
  waiting: 'Waiting for you',
  error: 'Error',
};

function renderHeader(s: ViewState) {
  header.replaceChildren();
  if (!s.signedIn) {
    header.append(
      el('h2', {}, 'Saras'),
      el('p', { class: 'muted' }, `Sign in to ${s.sarasUrl} to code your arena’s tasks here.`),
    );
    if (s.signIn) {
      const link = el('a', { href: '#' }, 'Open the sign-in page');
      link.addEventListener('click', (e) => {
        e.preventDefault();
        send({ type: 'openUrl', url: s.signIn?.uri ?? '' });
      });
      header.append(
        el('p', {}, 'Confirm this code in the browser:'),
        el('p', { class: 'code' }, s.signIn.userCode),
        el('p', {}, link),
        button('Cancel', command('cancelSignIn')),
      );
    } else header.append(button('Sign in', command('signIn'), 'primary'));
    return;
  }
  const iso =
    s.isolation === 'container'
      ? el(
          'span',
          { class: 'badge ok', title: 'Pi and its commands run inside the Dev Container' },
          'Isolated (Dev Container)',
        )
      : el(
          'span',
          {
            class: 'badge warn',
            title: 'Shell commands run on this computer and cannot be fully fenced',
          },
          'Host — commands need approval',
        );
  header.append(
    el(
      'div',
      { class: 'row spread' },
      el('span', { class: 'muted' }, s.user ? `${s.user.displayName}` : ''),
      el('span', { class: `status ${s.agent.status}` }, STATUS_LABEL[s.agent.status]),
    ),
    s.arena
      ? el(
          'div',
          { class: 'arena' },
          el('strong', {}, s.arena.name),
          s.arena.stage
            ? el('span', { class: 'muted' }, ` · ${s.arena.key} · ${s.arena.stage}`)
            : null,
        )
      : el(
          'div',
          { class: 'arena' },
          el('span', { class: 'muted' }, 'This folder is not linked to an arena.'),
          button('Link arena', command('linkArena'), 'primary'),
        ),
    el('div', { class: 'row' }, iso),
  );
  if (s.isolation === 'host-container-available') {
    header.append(
      el(
        'p',
        { class: 'muted' },
        'This folder has a Dev Container. Reopen it there so the agent runs isolated.',
      ),
      button('Reopen in Container', command('reopenInContainer')),
    );
  } else if (s.isolation === 'host') {
    header.append(
      el(
        'p',
        { class: 'muted small' },
        'Files outside this folder are blocked, but shell commands run on your computer. Approve only commands you understand, or use a Dev Container.',
      ),
    );
  }
  if (s.agent.error) header.append(el('p', { class: 'error' }, s.agent.error));
  const tools = el('div', { class: 'row wrap' });
  if (s.arena) tools.append(button('Clone arena repo', command('cloneArenaRepo')));
  if (s.isolation !== 'container')
    tools.append(button('Add Dev Container', command('scaffoldDevContainer')));
  tools.append(button('Refresh architecture', command('refreshArchitecture')));
  if (s.agent.status !== 'off') tools.append(button('Restart agent', command('restartAgent')));
  tools.append(button('Sign out', command('signOut')));
  header.append(el('details', {}, el('summary', {}, 'More'), tools));
}

function renderApproval(a: ApprovalRequest) {
  const card = el('div', {
    class: `card approval ${a.kind}`,
    role: 'group',
    'aria-label': a.title,
  });
  card.append(el('div', { class: 'card-title' }, a.title));
  if (a.kind === 'command') {
    card.append(
      el('pre', { class: 'command' }, a.detail),
      el('div', { class: 'muted small' }, `in ${a.cwd ?? ''}`),
    );
  } else if (a.kind === 'edit') {
    card.append(el('pre', { class: 'command' }, a.detail));
  } else {
    card.append(el('p', {}, a.detail));
  }
  if (a.reason) card.append(el('div', { class: 'muted small' }, a.reason));
  const seconds = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000));
  card.append(
    el(
      'div',
      { class: 'muted small' },
      `Denied automatically in ${Math.ceil(seconds / 60)} min if unanswered.`,
    ),
  );

  if (a.kind === 'question') {
    const row = el('div', { class: 'row wrap' });
    for (const o of a.options ?? [])
      row.append(button(o, () => send({ type: 'answer', id: a.id, answer: o })));
    const own = el('input', {
      type: 'text',
      placeholder: 'Or type an answer',
      'aria-label': 'Your answer',
    });
    own.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && own.value.trim())
        send({ type: 'answer', id: a.id, answer: own.value.trim() });
    });
    card.append(
      row,
      own,
      el(
        'div',
        { class: 'row' },
        button('Skip', () => send({ type: 'decision', id: a.id, decision: 'deny' })),
      ),
    );
    return card;
  }
  const reason = el('input', {
    type: 'text',
    placeholder: 'Reason for the agent (optional, sent on Deny)',
    'aria-label': 'Reason',
  });
  const row = el(
    'div',
    { class: 'row wrap' },
    button('Approve', () => send({ type: 'decision', id: a.id, decision: 'approve' }), 'primary'),
    a.kind === 'command'
      ? button('Approve for this session', () =>
          send({ type: 'decision', id: a.id, decision: 'approve_session' }),
        )
      : null,
    button('Deny', () =>
      send({
        type: 'decision',
        id: a.id,
        decision: 'deny',
        reason: reason.value.trim() || undefined,
      }),
    ),
  );
  card.append(row, reason);
  return card;
}

let renderedApprovals = '';
function renderApprovals(s: ViewState) {
  const key = s.approvals.map((a) => a.id).join(',');
  if (key === renderedApprovals) return; // keep typed reasons while the set is unchanged
  renderedApprovals = key;
  approvals.replaceChildren(...s.approvals.map(renderApproval));
}

function renderTask(s: ViewState) {
  taskSection.replaceChildren();
  const canStart = s.signedIn && !!s.arena && s.agent.status !== 'working';
  taskForm.hidden = !canStart || !!(s.task && !s.task.pr);
  // The chat works in any open folder, with or without an arena task (the agent starts on the
  // first message).
  composer.hidden = !s.signedIn || !s.folder;
  promptBox.placeholder = s.task
    ? 'Message the agent about this task (Ctrl+Enter to send)'
    : 'Ask the agent to build or change something in this folder (Ctrl+Enter to send)';
  if (s.task) {
    const t = s.task;
    taskSection.append(
      el(
        'div',
        { class: 'card' },
        el('div', { class: 'card-title' }, t.title),
        el('div', { class: 'muted small' }, `Branch ${t.branch}`),
        el(
          'div',
          { class: 'row wrap' },
          s.agent.status === 'working' || s.agent.status === 'waiting'
            ? button('Stop', command('stopAgent'))
            : null,
          button(
            t.pushed ? 'Push again' : 'Push branch',
            command('pushBranch'),
            t.pushed ? 'secondary' : 'primary',
            s.agent.status === 'working',
          ),
          t.pr
            ? (() => {
                const a = el('a', { href: '#' }, `PR #${t.pr.number}`);
                a.addEventListener('click', (e) => {
                  e.preventDefault();
                  send({ type: 'openUrl', url: t.pr?.link ?? '' });
                });
                return a;
              })()
            : button('Open PR', command('openPr'), 'secondary', !t.pushed),
        ),
      ),
    );
  }
  if (s.history.length) {
    taskSection.append(
      el(
        'details',
        {},
        el('summary', {}, `Earlier tasks (${s.history.length})`),
        el(
          'ul',
          { class: 'history' },
          ...s.history.map((h) =>
            el('li', {}, `${h.title} — ${h.branch}${h.pr ? ` · PR #${h.pr}` : ''}`),
          ),
        ),
      ),
    );
  }
}

function renderItem(i: TranscriptItem) {
  switch (i.kind) {
    case 'user':
      return el('div', { class: 'msg user' }, i.text);
    case 'assistant':
      return el(
        'div',
        { class: `msg ai${i.streaming ? ' streaming' : ''}` },
        i.thinking
          ? el(
              'details',
              { class: 'thinking' },
              el('summary', {}, 'Thinking'),
              el('pre', {}, i.thinking),
            )
          : null,
        i.text,
      );
    case 'notice':
      return el('div', { class: `notice ${i.level}` }, i.text);
    case 'tool': {
      const icon = i.status === 'running' ? '…' : i.status === 'ok' ? '✓' : '✕';
      const summary = el(
        'summary',
        {},
        el('span', { class: `tool-status ${i.status}` }, icon),
        ` ${i.tool} `,
        el('code', {}, i.summary),
      );
      const body: Child[] = [];
      if (i.diff)
        body.push(
          el(
            'pre',
            { class: 'diff' },
            ...i.diff
              .split('\n')
              .map((l) =>
                el(
                  'span',
                  { class: l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : '' },
                  `${l}\n`,
                ),
              ),
          ),
        );
      if (i.output && !i.diff) body.push(el('pre', { class: 'output' }, i.output));
      const d = el('details', { class: 'tool' }, summary, ...body);
      if (i.diff) d.open = true;
      return d;
    }
  }
}

let stickToBottom = true;
transcript.addEventListener('scroll', () => {
  stickToBottom = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 30;
});

function renderTranscript(s: ViewState) {
  const open = new Set(
    [...transcript.querySelectorAll('details[data-id]')]
      .filter((d) => (d as HTMLDetailsElement).open)
      .map((d) => d.getAttribute('data-id')),
  );
  transcript.replaceChildren(
    ...s.transcript.map((i) => {
      const node = renderItem(i);
      node.setAttribute('data-id', i.id);
      if (node instanceof HTMLDetailsElement && open.has(i.id)) node.open = true;
      return node;
    }),
  );
  if (s.transcript.length === 0 && s.signedIn && s.arena) {
    transcript.append(
      el(
        'p',
        { class: 'muted' },
        'Start a task: the agent works on its own branch in this folder. Edits appear here as diffs; commands ask you first.',
      ),
    );
  }
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  if (event.data?.type !== 'state') return;
  const s = event.data.state;
  renderHeader(s);
  renderApprovals(s);
  renderTask(s);
  if (!s.signedIn) {
    taskForm.hidden = true;
    composer.hidden = true;
  }
  renderTranscript(s);
});

send({ type: 'ready' });
