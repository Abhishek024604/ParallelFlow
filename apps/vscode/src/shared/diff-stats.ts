// Added/removed line counts for the chat's edit rows and the "N files changed" bar. Pure, so the
// host (transcript, from the full diff before clipping) and the webview (fallback) share it.
import type { TranscriptItem } from '../pi/transcript.js';

export interface DiffStats {
  added: number;
  removed: number;
}

/** Unified headers (`+++ b/x`, `--- a/x`) are not changes. */
const HEADER = /^(\+\+\+|---) (\S+\/|\/dev\/null)/;

/** Counts `+` and `-` lines of a diff (Pi's edit diff or a unified diff). */
export function countDiff(diff: string): DiffStats {
  const stats = { added: 0, removed: 0 };
  for (const line of diff.split('\n')) {
    if (HEADER.test(line)) continue;
    if (line.startsWith('+')) stats.added += 1;
    else if (line.startsWith('-')) stats.removed += 1;
  }
  return stats;
}

/** Lines in a file the agent wrote whole (a trailing newline ends the last line, it is not one). */
export function countLines(content: string): number {
  if (content === '') return 0;
  const lines = content.split('\n').length;
  return content.endsWith('\n') ? lines - 1 : lines;
}

export interface ChangedFile extends DiffStats {
  path: string;
}

type ToolItem = Extract<TranscriptItem, { kind: 'tool' }>;

/** Files the agent changed in this chat (successful edit and write calls), in first-touch order. */
export function changedFiles(items: readonly TranscriptItem[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const i of items) {
    if (i.kind !== 'tool' || i.status !== 'ok') continue;
    if (i.tool !== 'edit' && i.tool !== 'write') continue;
    if (!i.summary) continue;
    const s = statsOf(i);
    const f = byPath.get(i.summary) ?? { path: i.summary, added: 0, removed: 0 };
    f.added += s.added;
    f.removed += s.removed;
    byPath.set(i.summary, f);
  }
  return [...byPath.values()];
}

export function statsOf(i: ToolItem): DiffStats {
  return i.stats ?? countDiff(i.diff ?? '');
}

export function totalStats(files: readonly DiffStats[]): DiffStats {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), {
    added: 0,
    removed: 0,
  });
}
