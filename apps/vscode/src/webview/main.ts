// The chat webview (sidebar and editor tab load the same bundle). Chat-first: a compact header, the
// transcript filling the height with approvals inline at its end, then the task strip, changes bar
// and composer docked at the bottom. Parts are built once and updated from each state message.
import type { ToWebview, ViewState } from '../shared/messages.js';
import { ApprovalsView } from './approvals.js';
import { ChangesBar, TaskStrip } from './changes.js';
import { Composer } from './composer.js';
import { el, send } from './dom.js';
import { Header } from './header.js';
import { isTypingTarget } from './lib/keys.js';
import { TranscriptView } from './transcript.js';
import { renderWelcome } from './welcome.js';

const app = document.getElementById('app') as HTMLElement;
const header = new Header();
const transcript = new TranscriptView();
const approvals = new ApprovalsView();
const taskStrip = new TaskStrip();
const changes = new ChangesBar();
const composer = new Composer();

transcript.after.append(approvals.node);
app.append(
  header.node,
  el('div', { class: 'body' }, transcript.scroller, transcript.jump),
  el('div', { class: 'dock' }, taskStrip.node, changes.node, composer.node),
);

let welcomeSig = '';
function render(s: ViewState): void {
  header.render(s);
  const hasItems = s.transcript.length > 0 || s.approvals.length > 0;
  const sig = JSON.stringify([
    s.signedIn,
    s.signIn,
    s.folder,
    s.arena,
    s.mode,
    hasItems,
    s.architecture?.gates.some((g) => g.state !== 'empty'),
    s.history.length,
    s.parallelflowUrl,
  ]);
  if (sig !== welcomeSig) {
    welcomeSig = sig;
    renderWelcome(transcript.welcome, s, hasItems, { prompt: (text) => composer.sendText(text) });
  }
  transcript.render(s.signedIn ? s.transcript : []);
  if (approvals.render(s.signedIn ? s.approvals : [])) transcript.toBottom();
  taskStrip.render(s);
  changes.render(s);
  composer.render(s);
}

// Number keys answer the open approval when focus is not in a text field.
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
  const t = e.target as HTMLElement | null;
  if (isTypingTarget(t?.tagName, t?.isContentEditable)) return;
  if (approvals.count && approvals.key(e.key, e.target)) e.preventDefault();
});

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const m = event.data;
  switch (m?.type) {
    case 'state':
      render(m.state);
      return;
    case 'fileResults':
      composer.fileResults(m.requestId, m.files);
      return;
    case 'addContext':
      composer.addChip(m.chip);
      return;
    case 'focusComposer':
      composer.focus();
      return;
  }
});

send({ type: 'ready' });
