// Context chips from the chat composer (@file and selection references). The webview sends only
// folder-relative paths, never file contents; the host checks them and names them in the prompt.

const CHIP = /^[^\n\r\0]{1,300}$/;
const MAX_CHIPS = 20;

/** Keeps well-formed, distinct chips (`path` or `path:L3-L9`), at most 20. */
export function cleanChips(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const c of raw) {
    if (typeof c !== 'string') continue;
    const chip = c.trim();
    if (!CHIP.test(chip) || /^([\\/]|[a-zA-Z]:)/.test(chip) || /(^|[\\/])\.\.([\\/]|$)/.test(chip))
      continue;
    out.add(chip);
    if (out.size >= MAX_CHIPS) break;
  }
  return [...out];
}

/** The line the host appends to the prompt for the person's chips. */
export function contextLine(chips: readonly string[]): string {
  return chips.length ? `\n\nContext files: ${chips.map((c) => `@${c}`).join(', ')}` : '';
}

/** `src/a.ts:L3-L9` for a selection of lines 3 to 9 (1-based), `src/a.ts:L3` for one line. */
export function selectionChip(rel: string, startLine: number, endLine: number): string {
  const path = rel.replace(/\\/g, '/');
  return startLine === endLine ? `${path}:L${startLine}` : `${path}:L${startLine}-L${endLine}`;
}
