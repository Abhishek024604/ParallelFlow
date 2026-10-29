// Line diff counts for the Push preview ("+12 / −3 lines"): lines only in `after` are added, lines
// only in `before` are removed, by longest common subsequence. Large inputs fall back to comparing
// line multisets (order ignored) so the preview stays fast; the counts are a summary, not a patch.

import type { DiffLine } from '@parallelflow/contracts';

/** Above this many cells (lines × lines) the LCS table is skipped. */
const LCS_MAX_CELLS = 4_000_000;

const splitLines = (text: string): string[] =>
  text === '' ? [] : text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');

function multisetDiff(a: string[], b: string[]): { added: number; removed: number } {
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of b) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      common += 1;
      counts.set(line, n - 1);
    }
  }
  return { added: b.length - common, removed: a.length - common };
}

/** Above this many lines on either side, diffLines shows the whole of both instead. */
const LINES_MAX = 2000;

/**
 * A line diff to show (the push's "the arena changed since your copy" warning): kept, removed and
 * added lines in order, at most `maxOut` lines (`truncated` when cut). Content is never logged.
 */
export function diffLines(
  before: string,
  after: string,
  maxOut = 400,
): { lines: DiffLine[]; truncated: boolean } {
  const a = splitLines(before);
  const b = splitLines(after);
  let out: DiffLine[];
  if (a.length > LINES_MAX || b.length > LINES_MAX) {
    out = [
      ...a.map((text) => ({ op: '-' as const, text })),
      ...b.map((text) => ({ op: '+' as const, text })),
    ];
  } else {
    // LCS table, then walk it from the start.
    const n = a.length;
    const m = b.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      const row = table[i] as Uint32Array;
      const below = table[i + 1] as Uint32Array;
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ op: ' ', text: a[i] ?? '' });
        i += 1;
        j += 1;
      } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
        out.push({ op: '-', text: a[i] ?? '' });
        i += 1;
      } else {
        out.push({ op: '+', text: b[j] ?? '' });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ op: '-', text: a[i] ?? '' });
    for (; j < m; j += 1) out.push({ op: '+', text: b[j] ?? '' });
  }
  return { lines: out.slice(0, maxOut), truncated: out.length > maxOut };
}

export function lineDiff(before: string, after: string): { added: number; removed: number } {
  let a = splitLines(before);
  let b = splitLines(after);
  // Common prefix and suffix cost nothing.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  a = a.slice(start, endA);
  b = b.slice(start, endB);
  if (a.length === 0 || b.length === 0) return { added: b.length, removed: a.length };
  if (a.length * b.length > LCS_MAX_CELLS) return multisetDiff(a, b);

  // One row of the LCS table at a time.
  let prev = new Uint32Array(b.length + 1);
  let row = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      row[j] =
        a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, row[j - 1] ?? 0);
    }
    [prev, row] = [row, prev];
  }
  const common = prev[b.length] ?? 0;
  return { added: b.length - common, removed: a.length - common };
}
