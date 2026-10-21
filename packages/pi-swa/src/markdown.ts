import { createHash } from 'node:crypto';
import { parse, stringify } from 'yaml';

// Artifact text rules (docs/15 "Human and AI editable"): YAML frontmatter, stable sections the agent
// can replace one at a time, and architect-owned locked blocks it must never change.

export const LOCK_OPEN = '<!-- swa:locked -->';
export const LOCK_CLOSE = '<!-- /swa:locked -->';

/** sha256 of the text with line endings normalized (a CRLF checkout is not a change). */
export function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface Frontmatter {
  /** The parsed YAML mapping; empty when the file has none. */
  data: Record<string, unknown>;
  body: string;
  /** Set when there is a block but it is not a YAML mapping. */
  error?: string;
}

export function readFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text);
  if (!match) return { data: {}, body: text };
  const body = text.slice(match[0].length);
  try {
    const data: unknown = parse(match[1] ?? '');
    if (data === null || data === undefined) return { data: {}, body };
    if (typeof data !== 'object' || Array.isArray(data)) {
      return { data: {}, body, error: 'the frontmatter is not a YAML mapping' };
    }
    return { data: data as Record<string, unknown>, body };
  } catch (err) {
    return {
      data: {},
      body,
      error: `the frontmatter is not valid YAML (${(err as Error).message})`,
    };
  }
}

/** Replaces the frontmatter (keeps the body as it is). */
export function writeFrontmatter(data: Record<string, unknown>, body: string): string {
  return `---\n${stringify(data, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

/** Sets some frontmatter fields, adding a frontmatter block when there is none. */
export function setFrontmatterFields(text: string, fields: Record<string, unknown>): string {
  const fm = readFrontmatter(text);
  if (fm.error) return text;
  return writeFrontmatter({ ...fm.data, ...fields }, fm.body);
}

/**
 * The locked blocks, markers included, in order. An open marker with no close locks the rest of
 * the file. A close with no open is ordinary text.
 */
export function lockedBlocks(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n');
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = t.indexOf(LOCK_OPEN, from);
    if (start < 0) return blocks;
    const end = t.indexOf(LOCK_CLOSE, start + LOCK_OPEN.length);
    if (end < 0) {
      blocks.push(t.slice(start));
      return blocks;
    }
    blocks.push(t.slice(start, end + LOCK_CLOSE.length));
    from = end + LOCK_CLOSE.length;
  }
}

/** Null when `after` keeps every locked block of `before`, unchanged and in order (and adds none). */
export function lockedBlockViolation(before: string, after: string): string | null {
  const a = lockedBlocks(before);
  const b = lockedBlocks(after);
  if (a.length === b.length && a.every((block, i) => block === b[i])) return null;
  if (b.length > a.length) {
    return 'it adds a locked block: only the architect marks text as locked';
  }
  const changed = a.findIndex((block, i) => block !== b[i]);
  return `it changes or removes locked block ${changed + 1} of ${a.length}: text between ${LOCK_OPEN} and ${LOCK_CLOSE} belongs to the architect`;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;

/** Heading text without a trailing ID tag, lowercased: "## Quality scenarios {#qs}" → "quality scenarios". */
const headingKey = (text: string): string =>
  text
    .replace(/\{#[\w-]+\}\s*$/, '')
    .trim()
    .toLowerCase();

/**
 * Replaces one section: from its heading line to the next heading of the same or a higher level.
 * `heading` is the heading text, with or without the leading #s (case-insensitive). The new body
 * replaces everything under the heading; the heading line itself stays. Errors when the heading is
 * missing or appears more than once.
 */
export function replaceSection(
  text: string,
  heading: string,
  body: string,
): { text: string } | { error: string } {
  const want = headingKey(heading.replace(/^#+\s*/, ''));
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let fence = false;
  const matches: { index: number; level: number }[] = [];
  const headings: { index: number; level: number }[] = [];
  lines.forEach((line, index) => {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const h = HEADING.exec(line);
    if (!h?.[1] || !h[2]) return;
    headings.push({ index, level: h[1].length });
    if (headingKey(h[2]) === want) matches.push({ index, level: h[1].length });
  });
  if (matches.length === 0) return { error: `there is no section "${heading}"` };
  if (matches.length > 1) return { error: `there are ${matches.length} sections "${heading}"` };
  const target = matches[0] as { index: number; level: number };
  const next = headings.find((h) => h.index > target.index && h.level <= target.level);
  const end = next ? next.index : lines.length;
  const replacement = body.replace(/\r?\n/g, eol).replace(/\s+$/, '');
  const out = [
    ...lines.slice(0, target.index + 1),
    '',
    ...(replacement ? [replacement, ''] : []),
    ...lines.slice(end),
  ];
  return { text: out.join(eol).replace(/(\r?\n)+$/, eol) };
}
