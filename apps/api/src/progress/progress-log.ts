// The arena's progress log (pure: formatting, merging, parsing; unit tested).
//
// The log is one Markdown document, the arena's `progress` artifact (progress.md), newest entry
// first. An entry is written after every approved gate and after a busy stretch of discussion
// (~20 human messages). The arena's AI writes it when it can; otherwise a plain entry is built from
// the facts (stage moves, approvals, documents, counts), so the log always moves on. An AI entry for
// a gate replaces the plain one written in the vote's transaction (same entry id).
//
// Each entry starts with a marker line `<!-- progress-entry id=<id> at=<iso> -->` so entries can be
// found again without parsing the prose.

export type ProgressTrigger = 'gate' | 'messages';
export type ProgressSource = 'ai' | 'auto';

export interface ProgressEntry {
  id: string;
  /** ISO timestamp. */
  at: string;
  cycle: number | null;
  stage: string | null;
  trigger: ProgressTrigger;
  source: ProgressSource;
  summary: string;
  decisions: string[];
  timeline: string[];
  discussions: string[];
}

/** What changed in the arena since the previous entry (ids and names only, no message text). */
export interface ProgressFacts {
  since: string | null;
  cycle: number | null;
  stage: string | null;
  moves: {
    at: string;
    cycle: number;
    from: string | null;
    to: string;
    kind: string;
    actor: string | null;
    reason: string | null;
  }[];
  approvals: {
    at: string;
    stage: string;
    status: string;
    summary: string | null;
    document: string | null;
  }[];
  documents: { name: string; version: number; approved: boolean }[];
  humanMessages: number;
  aiMessages: number;
}

export const LOG_TITLE = '# Progress log';
const LOG_INTRO =
  '_Newest first. Written after every approved gate and after busy discussions, by the arena’s AI when it can, otherwise from the recorded facts._';
export const MAX_ENTRIES = 100;
const MAX_ITEMS = 8;
const MAX_LINE = 300;

const MARKER = /^<!-- progress-entry id=([^\s]+) at=([^\s]+) -->$/m;
const MARKER_GLOBAL = /^<!-- progress-entry id=([^\s]+) at=([^\s]+) -->$/gm;

const oneLine = (text: string, max = MAX_LINE): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

const cleanList = (items: readonly string[]): string[] =>
  items
    .map((item) => oneLine(item.replace(/^[-*•\d.)\s]+/, '')))
    .filter((item) => item && !/^(none|n\/a|nothing|-)\.?$/i.test(item))
    .slice(0, MAX_ITEMS);

/** "2026-10-18 14:02 UTC" */
export function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

const MOVE_WORD: Record<string, string> = {
  advance: 'approved',
  send_back: 'sent back',
  open: 'opened',
  auto: 'moved',
  skip: 'skipped',
};

function moveLine(m: ProgressFacts['moves'][number]): string {
  const step = m.from ? `${m.from} → ${m.to}` : m.to;
  const why = m.reason ? ` (${oneLine(m.reason, 160)})` : '';
  return `${stamp(m.at)} · Cycle ${m.cycle} · ${step} · ${MOVE_WORD[m.kind] ?? m.kind} by ${m.actor ?? 'someone'}${why}`;
}

/** One entry as Markdown. */
export function formatEntry(entry: ProgressEntry): string {
  const where =
    entry.cycle !== null ? `Cycle ${entry.cycle}${entry.stage ? ` · ${entry.stage}` : ''}` : '';
  const why = entry.trigger === 'gate' ? 'after a gate approval' : 'after team discussion';
  const by = entry.source === 'ai' ? 'AI' : 'recorded facts';
  const section = (title: string, items: string[]) =>
    items.length ? `\n\n**${title}**\n\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  return [
    `<!-- progress-entry id=${entry.id} at=${entry.at} -->`,
    `## ${stamp(entry.at)}${where ? ` · ${where}` : ''}`,
    '',
    `_${why} · by ${by}_`,
    '',
    oneLine(entry.summary, 600) || 'No notable change.',
  ]
    .join('\n')
    .concat(section('Decisions', entry.decisions))
    .concat(section('Timeline', entry.timeline))
    .concat(section('Discussions', entry.discussions));
}

export interface LoggedEntry {
  id: string;
  at: string;
  /** The entry's Markdown, marker included. */
  text: string;
}

/** The entries in a log, in document order (newest first). */
export function parseLog(content: string | null | undefined): LoggedEntry[] {
  if (!content) return [];
  const marks = [...content.matchAll(MARKER_GLOBAL)];
  return marks.map((m, i) => {
    const start = m.index ?? 0;
    const end = marks[i + 1]?.index ?? content.length;
    return { id: m[1] ?? '', at: m[2] ?? '', text: content.slice(start, end).trim() };
  });
}

/**
 * The log with `entry` added: an entry with the same id is replaced in place of the old one, and
 * entries are kept newest first, at most MAX_ENTRIES.
 */
export function mergeLog(existing: string | null | undefined, entry: ProgressEntry): string {
  const others = parseLog(existing).filter((e) => e.id !== entry.id);
  const all = [{ id: entry.id, at: entry.at, text: formatEntry(entry) }, ...others]
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
    .slice(0, MAX_ENTRIES);
  return `${LOG_TITLE}\n\n${LOG_INTRO}\n\n${all.map((e) => e.text).join('\n\n')}\n`;
}

/** When the newest entry other than `exceptId` was written (the start of the next window). */
export function lastEntryAt(content: string | null | undefined, exceptId?: string): string | null {
  const entry = parseLog(content).find((e) => e.id !== exceptId);
  return entry?.at ?? null;
}

/** Whether a text has a progress-entry marker (used by tests and the snapshot). */
export const hasEntries = (content: string | null | undefined): boolean =>
  Boolean(content && MARKER.test(content));

/** A plain entry from the facts, used when the AI cannot write one. */
export function factsEntry(
  base: Pick<ProgressEntry, 'id' | 'at' | 'trigger'>,
  facts: ProgressFacts,
): ProgressEntry {
  const decided = facts.approvals.filter((a) => a.status === 'approved' || a.status === 'rejected');
  const advanced = facts.moves.filter((m) => m.kind === 'advance');
  const parts: string[] = [];
  if (advanced.length) {
    const last = advanced.at(-1);
    if (last) parts.push(`The cycle moved ${last.from ?? ''} → ${last.to}.`.replace('  ', ' '));
  }
  const sentBack = facts.moves.filter((m) => m.kind === 'send_back').length;
  if (sentBack) parts.push(`Sent back ${sentBack === 1 ? 'once' : `${sentBack} times`}.`);
  if (facts.documents.length) {
    parts.push(
      `${facts.documents.length} document${facts.documents.length === 1 ? '' : 's'} changed.`,
    );
  }
  parts.push(
    `${facts.humanMessages} message${facts.humanMessages === 1 ? '' : 's'} from the team and ${facts.aiMessages} from the AI.`,
  );
  return {
    ...base,
    cycle: facts.cycle,
    stage: facts.stage,
    source: 'auto',
    summary: parts.join(' '),
    decisions: decided.map(
      (a) =>
        `${a.stage} gate ${a.status === 'approved' ? 'approved' : 'not approved'}${
          a.document ? ` with ${a.document}` : ''
        }${a.summary ? `: ${oneLine(a.summary, 160)}` : ''}`,
    ),
    timeline: facts.moves.map(moveLine).slice(-MAX_ITEMS),
    discussions: [],
  };
}

/** The instruction for the AI's progress turn: facts in, a fixed reply format out. */
export function progressPrompt(facts: ProgressFacts, trigger: ProgressTrigger): string {
  const lines = [
    'Write a progress-log entry for this arena. This is not a chat message: your reply is saved to the arena’s progress log and is not posted. Do not call tools that create or change documents.',
    trigger === 'gate'
      ? 'Reason: a stage gate was just approved.'
      : 'Reason: the team has been discussing a lot since the last entry.',
    facts.since
      ? `Cover only what happened since ${stamp(facts.since)}. Read the arena history with your tools to see the discussion.`
      : 'Cover the arena so far. Read the arena history with your tools to see the discussion.',
    '',
    'Facts recorded by the app:',
    `- Now: ${facts.cycle !== null ? `cycle ${facts.cycle}, stage ${facts.stage ?? '?'}` : 'no cycle yet'}`,
    `- Messages since: ${facts.humanMessages} from people, ${facts.aiMessages} from the AI`,
    ...facts.moves.map((m) => `- Stage move: ${moveLine(m)}`),
    ...facts.approvals.map(
      (a) => `- Gate ${a.stage}: ${a.status}${a.document ? ` (document ${a.document})` : ''}`,
    ),
    ...facts.documents.map(
      (d) => `- Document ${d.name} v${d.version}${d.approved ? ' (approved)' : ' (draft)'}`,
    ),
    '',
    'Be concise. Leave out greetings, chatter, jokes and anything off-topic. Reply in exactly this format and nothing else:',
    'SUMMARY: <one or two lines: what changed>',
    'DECISIONS:',
    '- <a decision the team made, or none>',
    'TIMELINE:',
    '- <a milestone, date or deadline mentioned, or none>',
    'DISCUSSIONS:',
    '- <one line per major discussion: topic and outcome, or none>',
  ];
  return lines.join('\n');
}

type Section = 'decisions' | 'timeline' | 'discussions';
const HEADINGS: Record<string, Section> = {
  DECISIONS: 'decisions',
  TIMELINE: 'timeline',
  DISCUSSIONS: 'discussions',
};

/** The AI's reply in the format above, or null when it does not follow it. */
export function parseAiProgress(
  text: string,
): Pick<ProgressEntry, 'summary' | 'decisions' | 'timeline' | 'discussions'> | null {
  const out = {
    summary: '',
    decisions: [] as string[],
    timeline: [] as string[],
    discussions: [] as string[],
  };
  let current: Section | 'summary' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[#*_\s]+|[*_]+$/g, '').trim();
    if (!line) continue;
    // "SUMMARY: …", "**Decisions:**", "## Timeline" (a heading with no colon ends the line).
    const head = /^(SUMMARY|DECISIONS|TIMELINE|DISCUSSIONS)[*_\s]*(?::[*_\s]*(.*))?$/i.exec(line);
    if (head) {
      const name = (head[1] ?? '').toUpperCase();
      const rest = (head[2] ?? '').trim();
      if (name === 'SUMMARY') {
        current = 'summary';
        if (rest) out.summary = rest;
      } else {
        current = HEADINGS[name] ?? null;
        if (current && rest) out[current].push(rest);
      }
      continue;
    }
    if (current === 'summary') out.summary = out.summary ? `${out.summary} ${line}` : line;
    else if (current) out[current].push(line);
  }
  const summary = oneLine(out.summary, 600);
  if (!summary) return null;
  return {
    summary,
    decisions: cleanList(out.decisions),
    timeline: cleanList(out.timeline),
    discussions: cleanList(out.discussions),
  };
}

/** The progress.md of the arena's repo: the log (newest first), then every stage move. */
export function renderProgressFile(input: {
  log: string | null;
  current: { number: number; stage: string; status: string } | null;
  moves: ProgressFacts['moves'];
  approvedFiles: string[];
}): string {
  const entries = parseLog(input.log);
  const now = input.current
    ? `Cycle ${input.current.number} · ${input.current.stage} (${input.current.status})`
    : 'No cycle yet.';
  const log = entries.length
    ? entries.map((e) => e.text.replace(MARKER, '').trim().replace(/^## /, '### ')).join('\n\n')
    : 'No entries yet.';
  const moves = input.moves.map((m) => `- ${moveLine(m)}`).join('\n') || 'None yet.';
  const files =
    input.approvedFiles.map((f) => `- [${f}](${encodeURI(f)})`).join('\n') || 'None yet.';
  return `# Progress\n\n${now}\n\n## Log\n\n${log}\n\n## Stage moves\n\n${moves}\n\n## Approved documents\n\n${files}\n`;
}
