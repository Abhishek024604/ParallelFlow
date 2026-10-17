// When an AI turn saves a document (artifact.proposed), the chat reply should say so in one line and
// never repeat the document. The prompts ask for that; this guard enforces it: if the reply carries a
// large part of a saved document, the stored message becomes the short "Created …" line(s). The
// document itself is shown as a file card (messages.artifact_refs).

export interface SavedDraft {
  artifactId: string;
  name: string;
  versionNo: number;
  content: string;
}

/** Contents shorter than this may be quoted freely (a title, a one-line config). */
const MIN_GUARDED_CHARS = 160;
/** A reply that repeats this many characters of a document's lines is a paste. */
const PASTED_CHARS = 300;
/** …or this share of the document's text. */
const PASTED_SHARE = 0.5;
/** Lines shorter than this are too generic to count ("```", "- yes", headings like "## Goal"). */
const MIN_LINE_CHARS = 16;

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** How many characters of the content's (distinct, non-trivial) lines appear in the reply. */
export function pastedChars(reply: string, content: string): number {
  const haystack = squash(reply);
  if (!haystack) return 0;
  let matched = 0;
  const seen = new Set<string>();
  for (const raw of content.split(/\r?\n/)) {
    const line = squash(raw.replace(/^[\s>*#-]+/, ''));
    if (line.length < MIN_LINE_CHARS || seen.has(line)) continue;
    seen.add(line);
    if (haystack.includes(line)) matched += line.length;
  }
  return matched;
}

/** Whether the reply repeats a large part of the content. */
export function repeatsContent(reply: string, content: string): boolean {
  const total = squash(content).length;
  if (total < MIN_GUARDED_CHARS) return false;
  const matched = pastedChars(reply, content);
  return matched >= PASTED_CHARS || matched >= total * PASTED_SHARE;
}

/** One line about the document: its first heading or first line, cut short. */
function gist(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const first = lines.find((l) => /^#{1,3}\s/.test(l)) ?? lines[0] ?? '';
  const text = first.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '');
  return text.length > 100 ? `${text.slice(0, 99)}…` : text;
}

/** "Created goal.md (draft v1) — Goal for the launch" */
export function createdLine(draft: SavedDraft): string {
  const verb = draft.versionNo > 1 ? 'Updated' : 'Created';
  const about = gist(draft.content);
  return `${verb} ${draft.name} (draft v${draft.versionNo})${about ? ` — ${about}` : ''}`;
}

/**
 * The reply to store for a turn that saved drafts: unchanged when it does not repeat a draft, else
 * one "Created …" line per draft.
 */
export function guardReply(reply: string, drafts: readonly SavedDraft[]): string {
  if (drafts.length === 0) return reply;
  if (!drafts.some((d) => repeatsContent(reply, d.content))) return reply;
  return drafts.map(createdLine).join('\n');
}
