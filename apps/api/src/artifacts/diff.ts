// Line diff counts for the Push preview ("+12 / −3 lines"): lines only in `after` are added, lines
// only in `before` are removed, by longest common subsequence. Large inputs fall back to comparing
// line multisets (order ignored) so the preview stays fast; the counts are a summary, not a patch.

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
