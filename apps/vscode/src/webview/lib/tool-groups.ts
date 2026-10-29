// Turns transcript items into chat rows: runs of look-around tools (read, ls, find, grep) fold into
// one "Read 4 files, searched 2 times" row; everything else is a row of its own. Pure.
import type { TranscriptItem } from '../../pi/transcript.js';

export type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

export type Row =
  | { kind: 'item'; key: string; item: TranscriptItem }
  /** One or more consecutive explore tools. The key is the first item's, so the row is stable. */
  | { kind: 'explore'; key: string; items: ToolItem[] };

export const EXPLORE_TOOLS: ReadonlySet<string> = new Set(['read', 'ls', 'find', 'grep']);

export function toRows(items: readonly TranscriptItem[]): Row[] {
  const rows: Row[] = [];
  let run: ToolItem[] | undefined;
  for (const item of items) {
    if (item.kind === 'tool' && EXPLORE_TOOLS.has(item.tool)) {
      if (!run) {
        run = [];
        rows.push({ kind: 'explore', key: `g:${item.id}`, items: run });
      }
      run.push(item);
      continue;
    }
    run = undefined;
    rows.push({ kind: 'item', key: item.id, item });
  }
  return rows;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "Read 4 files, searched 2 times, listed 1 folder". */
export function exploreLabel(items: readonly ToolItem[]): string {
  const reads = new Set(items.filter((i) => i.tool === 'read').map((i) => i.summary)).size;
  const searches = items.filter((i) => i.tool === 'grep' || i.tool === 'find').length;
  const lists = items.filter((i) => i.tool === 'ls').length;
  const parts = [
    reads ? `read ${plural(reads, 'file', 'files')}` : '',
    searches ? `searched ${plural(searches, 'time', 'times')}` : '',
    lists ? `listed ${plural(lists, 'folder', 'folders')}` : '',
  ].filter(Boolean);
  const label = parts.join(', ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** Status of a group: running while any call runs, error when any failed. */
export function groupStatus(items: readonly ToolItem[]): ToolItem['status'] {
  if (items.some((i) => i.status === 'running')) return 'running';
  return items.some((i) => i.status === 'error') ? 'error' : 'ok';
}

/** Codicon name per tool. */
export function toolIcon(tool: string): string {
  if (tool.startsWith('mcp__')) return 'plug';
  const icons: Record<string, string> = {
    read: 'file',
    edit: 'edit',
    write: 'new-file',
    bash: 'terminal',
    grep: 'search',
    find: 'search',
    ls: 'folder',
    ask_user: 'comment-discussion',
  };
  return icons[tool] ?? 'tools';
}

export function toolVerb(tool: string): string {
  if (tool.startsWith('mcp__')) return tool.split('__')[1] ?? 'Tool';
  const verbs: Record<string, string> = {
    read: 'Read',
    edit: 'Edit',
    write: 'Write',
    bash: 'Run',
    grep: 'Search',
    find: 'Find',
    ls: 'List',
    ask_user: 'Ask',
  };
  return verbs[tool] ?? tool;
}
