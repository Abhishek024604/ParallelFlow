// Output filter for AI text (stored replies and live deltas). The prompts ask the AI to talk about
// files and people by name and never expose internals; this enforces the worst of it. It removes
// internal ids (UUIDs, with their "(ID: …)" wrappers), anything that looks like a token or key, and
// internal tool and field names, keeping the wording natural. Text is never logged.

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
  'files.list',
  'files.read',
  'private.list_artifacts',
  'private.read_artifact',
  'tasks.update_status',
  'tasks.comment',
  'approval.request',
  'routine.context',
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
