// Ported from apps/api/src/agent/output-filter.ts and paste-guard.ts (which stay as the API's backstop).
// Here they run inside the harness: Pi's message_end hook replaces the finalized assistant message
// with the cleaned one, and the runtime filters live deltas with StreamSanitizer before emitting them.

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** App Tools names (app-tools_v0.2.mcp.json), dotted and in their model-facing `_` form. */
const TOOL_NAMES = [
  'arena.read_history',
  'arena.post_message',
  'project.get_overview',
  'members.list',
  'cycle.get_state',
  'artifacts.list',
  'artifacts.read',
  'artifacts.create_draft',
  'private.save_artifact',
  'bridge.propose_push',
  'tasks.list',
  'tasks.create_draft',
  'delegation.suggest',
  'stage.request_gate',
  'notify.tag',
  'knowledge.search',
  'memory.recall',
  'files.list',
  'files.read',
  'private.list_artifacts',
  'private.read_artifact',
  'tasks.update_status',
  'tasks.comment',
  'approval.request',
  'routine.context',
  'ask.question',
  // The extension's own tools.
  'ask_user',
  'load_skill',
];

/**
 * ParallelFlow-internal field names the AI may echo from tool results → plain words. Generic names
 * (created_at, version…) are left alone: people discuss their own schemas in the arena.
 */
const FIELD_WORDS: Record<string, string> = {
  latest_version_no: 'latest version',
  head_version_no: 'latest version',
  approved_version_no: 'approved version',
  private_session_id: 'chat',
  session_key: 'session',
  source_ref: 'source',
  created_by_type: 'author',
  latest_written_by: 'author',
  latest_how: 'origin',
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BT = '`';

const TOOL = new RegExp(
  `${BT}?\\b(?:${TOOL_NAMES.flatMap((n) => [n, n.replace(/\./g, '_')])
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|')})\\b(?:\\(\\))?${BT}?`,
  'g',
);

const FIELD = new RegExp(
  `${BT}?\\b(${Object.keys(FIELD_WORDS).map(escape).join('|')})\\b${BT}?`,
  'g',
);

const SECRET = new RegExp(
  [
    // JWTs
    'eyJ[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}\\.[A-Za-z0-9_-]{6,}',
    // Provider keys: sk-/pk- style, Stripe, GitHub, Slack, AWS, Google
    '\\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}',
    '\\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{12,}',
    '\\bgh[pousr]_[A-Za-z0-9]{20,}',
    '\\bxox[abprs]-[A-Za-z0-9-]{10,}',
    '\\bAKIA[0-9A-Z]{16}\\b',
    '\\bAIza[0-9A-Za-z_-]{30,}',
  ].join('|'),
  'g',
);

const RULES: [RegExp, string][] = [
  // The model sometimes echoes the framing it was given around a message (<message from="…">).
  [/<\/?message\b[^>]*>\s*/gi, ''],
  // Bearer tokens and labelled secrets keep their label: "Authorization: Bearer [hidden]".
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/g, '$1 [hidden]'],
  [
    /\b(api[_ -]?key|secret|token|password|access[_ -]?key)(\s*[:=]\s*)["'`]?[^\s"'`]{8,}["'`]?/gi,
    '$1$2[hidden]',
  ],
  [SECRET, '[hidden]'],
  // "(ID: …)", "[id …]", "(artifact 0190…, version 2)": the whole parenthetical goes.
  [new RegExp(`\\s*[(\\[][^()\\[\\]\\n]{0,80}?${UUID}[^()\\[\\]\\n]{0,40}?[)\\]]`, 'g'), ''],
  // "ID: 0190…", "artifact_id = 0190…", "id is 0190…".
  [
    new RegExp(
      `\\s*\\b(?:[A-Za-z]+_)?(?:id|uuid|ID|Id|UUID)\\b\\s*(?:is\\s+|[:=#]\\s*)?${BT}?${UUID}${BT}?`,
      'g',
    ),
    '',
  ],
  // Any other UUID, with its backticks.
  [new RegExp(`\\s*${BT}?${UUID}${BT}?`, 'g'), ''],
  // Tool names: "`artifacts_read`" → "my tools".
  [TOOL, 'my tools'],
];

function tidy(text: string): string {
  return (
    text
      // Empty wrappers and punctuation left behind by a removal.
      .replace(/\(\s*\)|\[\s*\]|``/g, '')
      .replace(/[ \t]+([,.;:!?])/g, '$1')
      .replace(/([,;:])(?=[,.;:])/g, '')
      .replace(/^[ \t]*[,;:][ \t]*/gm, '')
      .replace(/([^\s])[ \t]{2,}/g, '$1 ')
  );
}

/** The AI's text with internal ids, secrets, tool and field names removed. */
export function sanitizeAiText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  out = out.replace(FIELD, (_, field: string) => FIELD_WORDS[field] ?? field);
  // Tidy only around a removal, so code and ordinary punctuation stay as written.
  return out === text ? out : tidy(out);
}

/** Held text is bounded: past this, a long run without spaces is released anyway. */
const MAX_HELD_CHARS = 400;

/**
 * Filters streamed deltas: text is released up to the last-but-one word boundary (so "ID: <uuid>"
 * and ids split across deltas are seen whole), and never inside an open "(" or "[" (so "(ID: …)"
 * goes as one). `flush` releases the rest at the end of the message.
 */
export class StreamSanitizer {
  private pending = '';

  push(chunk: string): string {
    this.pending += chunk;
    const cut = safeCut(this.pending);
    if (cut <= 0) return '';
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return sanitizeAiText(ready);
  }

  flush(): string {
    const rest = this.pending;
    this.pending = '';
    return rest ? sanitizeAiText(rest) : '';
  }
}

function safeCut(text: string): number {
  if (text.length > MAX_HELD_CHARS) {
    const boundary = text.lastIndexOf(' ', text.length - 120);
    return boundary > 0 ? boundary : text.length - 120;
  }
  const spaces = [...text.matchAll(/\s+/g)];
  let cut = spaces.length >= 2 ? (spaces[spaces.length - 2]?.index ?? 0) : 0;
  const open = Math.max(text.lastIndexOf('('), text.lastIndexOf('['));
  const closed = Math.max(text.lastIndexOf(')'), text.lastIndexOf(']'));
  if (open >= 0 && closed < open && open < cut) cut = open;
  return cut;
}

/** A document the turn saved (the harness does not know its version number; the app does). */
export interface SavedDraft {
  name: string;
  content: string;
  /** Known version (the app's guard), or undefined in the harness. */
  versionNo?: number;
  /** A new version of an existing document (the call named one), when the version is unknown. */
  update?: boolean;
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

/** "Created goal.md (draft v1) — Goal for the launch" ("(draft)" when the version is unknown). */
export function createdLine(draft: SavedDraft): string {
  const updated = draft.versionNo !== undefined ? draft.versionNo > 1 : draft.update === true;
  const verb = updated ? 'Updated' : 'Created';
  const version = draft.versionNo !== undefined ? `draft v${draft.versionNo}` : 'draft';
  const about = gist(draft.content);
  return `${verb} ${draft.name} (${version})${about ? ` — ${about}` : ''}`;
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

/** The text parts of a message's content, or '' for none. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        !!part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string',
    )
    .map((part) => part.text)
    .join('');
}

/**
 * A finalized assistant message's content with its text cleaned (ids, secrets, tool names) and, when
 * it repeats a document the turn saved, its text replaced by the "Created …" line. Non-text parts
 * (tool calls, thinking) are kept. Returns null when nothing changed.
 */
export function cleanAssistantContent(
  content: unknown,
  drafts: readonly SavedDraft[],
): unknown[] | null {
  if (!Array.isArray(content)) return null;
  const text = contentText(content);
  if (!text.trim()) return null;
  const cleaned = guardReply(sanitizeAiText(text), drafts);
  if (cleaned === text) return null;
  const rest = content.filter(
    (part) => !(part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'),
  );
  // One text part in place of the first one, the other parts in their order.
  const first = content.findIndex(
    (part) => part && typeof part === 'object' && (part as { type?: unknown }).type === 'text',
  );
  const out = [...rest];
  out.splice(Math.min(first, out.length), 0, { type: 'text', text: cleaned });
  return out;
}
