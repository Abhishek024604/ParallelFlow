// The composer's / menu (SWA prompts, review, and host actions) and @ file mention parsing. Pure.
import type { HostCommand } from '../../shared/messages.js';

export type SlashAction =
  /** Sends the text as a prompt right away. */
  | { kind: 'send'; text: string }
  /** Puts the text in the box for the person to finish (arguments). */
  | { kind: 'insert'; text: string }
  | { kind: 'command'; command: HostCommand };

export interface SlashItem {
  label: string;
  detail: string;
  icon: string;
  action: SlashAction;
}

const swa = (sub: string, detail: string, send = false): SlashItem => ({
  label: `/swa ${sub}`,
  detail,
  icon: 'symbol-structure',
  action: send ? { kind: 'send', text: `/swa ${sub}` } : { kind: 'insert', text: `/swa ${sub} ` },
});

const action = (label: string, detail: string, icon: string, command: HostCommand): SlashItem => ({
  label,
  detail,
  icon,
  action: { kind: 'command', command },
});

/** Pi prompts the agent loads (pi-swa prompts, pi-parallelflow `review`) and host actions. */
export const SLASH_ITEMS: readonly SlashItem[] = [
  action('/task', 'Start a task: pick a story to build', 'tasklist', 'startTask'),
  action('/new', 'New chat', 'add', 'newChat'),
  action('/history', 'Continue an earlier chat', 'history', 'resumeChat'),
  action('/push', 'Push the task branch', 'cloud-upload', 'pushBranch'),
  action('/pr', 'Open or update the pull request', 'git-pull-request', 'openPr'),
  action('/mode', 'Switch between Coder and Architect mode', 'arrow-swap', 'switchMode'),
  action('/build', 'Start building an arena in a new folder', 'rocket', 'startBuilding'),
  action('/stop', 'Stop the agent', 'debug-stop', 'stopAgent'),
  action('/restart', 'Restart the agent', 'debug-restart', 'restartAgent'),
  action('/tab', 'Open this chat in an editor tab', 'link-external', 'openChatTab'),
  {
    label: '/review',
    detail: 'Review a change, document or file for correctness, security and tests',
    icon: 'checklist',
    action: { kind: 'insert', text: '/review ' },
  },
  swa('status', 'Architecture gates and the next step', true),
  swa('help', 'How the architecture workflow works', true),
  swa('init', 'Create the arch/ input files', true),
  swa('intake', 'Phase 0: requirement IDs, quality scenarios and questions'),
  swa('stack', 'Phase 1: architecture style, technology per layer and ADRs'),
  swa('hld', 'Phase 2: model.yaml, the HLD and its diagrams'),
  swa('review-design', 'Phase 3: review the HLD before the baseline'),
  swa('lld', 'Phase 4: the LLD of one component (<CMP-id>)'),
  swa('review-code', 'Phase 5: conformance review of the code'),
  swa('impact', 'Phase 6: what a change affects and where to re-enter'),
  swa('adr', 'Record one architecture decision'),
];

/** The menu query when the box holds only a command being typed ("/sw" → "sw"). */
export function slashQuery(text: string): string | undefined {
  if (!text.startsWith('/') || text.includes('\n')) return undefined;
  return text.slice(1);
}

/** Items whose command starts with the query first, then those containing it anywhere. */
export function filterSlash(query: string, items: readonly SlashItem[] = SLASH_ITEMS): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const starts: SlashItem[] = [];
  const contains: SlashItem[] = [];
  for (const item of items) {
    const name = item.label.slice(1).toLowerCase();
    if (name.startsWith(q)) starts.push(item);
    else if (name.includes(q) || item.detail.toLowerCase().includes(q)) contains.push(item);
  }
  return [...starts, ...contains];
}

/**
 * The @ mention the caret is in: an `@` at the start or after whitespace, then no whitespace up to
 * the caret. `start` is the index of the `@`.
 */
export function mentionAt(
  text: string,
  caret: number,
): { start: number; query: string } | undefined {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return undefined;
  if (at > 0 && !/\s/.test(before.charAt(at - 1))) return undefined;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return undefined;
  return { start: at, query };
}

/** Removes the `@query` the caret was in, returning the new text and caret. */
export function removeMention(
  text: string,
  mention: { start: number; query: string },
): { text: string; caret: number } {
  const end = mention.start + 1 + mention.query.length;
  return { text: text.slice(0, mention.start) + text.slice(end), caret: mention.start };
}
