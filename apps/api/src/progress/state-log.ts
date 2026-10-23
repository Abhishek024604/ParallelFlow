import {
  dayOf,
  decisionLine,
  LEGACY_LOG_TITLE,
  oneLine,
  type ProgressFacts,
  type ProgressTrigger,
  stamp,
} from './progress-log.js';

// The arena's STATE.md (pure: formatting, merging, parsing; unit tested): a date-wise summary of the
// arena's discussions, one section per day (newest first), with that day's major decisions in bold,
// what was discussed and the open questions. No chatter.
//
// The arena's AI writes it, in its own session, through the progress job (progress-jobs.ts): after
// every approved gate and after a busy stretch of discussion. The AI is given the day's section so
// far and rewrites it; decisions are never lost (a merge keeps every decision already recorded that
// day). When the AI is unavailable, the day gets the recorded decisions instead (gate approvals,
// rejections and send-backs with their reasons).
//
// Each day starts with a marker line `<!-- state-day date=<yyyy-mm-dd> source=<ai|auto> -->`.

export type StateSource = 'ai' | 'auto';

export interface StateDay {
  /** yyyy-mm-dd (UTC). */
  date: string;
  source: StateSource;
  summary: string;
  decisions: string[];
  discussed: string[];
  questions: string[];
}

export const STATE_TITLE = '# Arena state';
export const STATE_FILE_NAME = 'STATE.md';
export const MAX_DAYS = 120;
const MAX_TIMELINE = 60;
const MAX_ITEMS = 10;

const DAY_MARKER = /^<!-- state-day date=(\d{4}-\d{2}-\d{2}) source=(ai|auto) -->$/gm;

const SECTIONS = {
  decisions: 'Decisions',
  discussed: 'Discussed',
  questions: 'Open questions',
} as const;
type ListKey = keyof typeof SECTIONS;

const clean = (item: string): string =>
  oneLine(
    item
      .trim()
      .replace(/^(?:[-*•]|\d+[.)])\s+/, '')
      .replace(/^\*\*(.*)\*\*$/, '$1'),
  );

const cleanList = (items: readonly string[], max = MAX_ITEMS): string[] =>
  items
    .map(clean)
    .filter((item) => item && !/^(none|n\/a|nothing|no open questions|-)\.?$/i.test(item))
    .slice(0, max);

/** Items of `a` then those of `b` not already in it (case-insensitive). */
function union(a: readonly string[], b: readonly string[]): string[] {
  const seen = new Set(a.map((x) => x.toLowerCase()));
  return [...a, ...b.filter((x) => !seen.has(x.toLowerCase()))].slice(0, MAX_ITEMS * 2);
}

/** One day as Markdown: decisions highlighted in bold. */
export function formatDay(day: StateDay): string {
  const list = (key: ListKey, bold = false) =>
    day[key].length
      ? `\n\n**${SECTIONS[key]}**\n\n${day[key].map((i) => (bold ? `- **${i}**` : `- ${i}`)).join('\n')}`
      : '';
  return [
    `<!-- state-day date=${day.date} source=${day.source} -->`,
    `## ${day.date}`,
    '',
    day.summary || 'No summary.',
  ]
    .join('\n')
    .concat(list('decisions', true))
    .concat(list('discussed'))
    .concat(list('questions'));
}

/** The days of a STATE.md, in document order (newest first). */
export function parseState(content: string | null | undefined): StateDay[] {
  if (!content) return [];
  const marks = [...content.matchAll(DAY_MARKER)];
  return marks.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const to = marks[i + 1]?.index ?? content.length;
    return parseDayBody(m[1] ?? '', (m[2] ?? 'auto') as StateSource, content.slice(from, to));
  });
}

function parseDayBody(date: string, source: StateSource, body: string): StateDay {
  const day: StateDay = { date, source, summary: '', decisions: [], discussed: [], questions: [] };
  const byTitle = new Map<string, ListKey>(
    (Object.keys(SECTIONS) as ListKey[]).map((k) => [SECTIONS[k], k]),
  );
  let current: ListKey | 'summary' = 'summary';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('## ')) continue;
    const heading = /^\*\*(.+)\*\*$/.exec(line)?.[1];
    if (heading && byTitle.has(heading)) {
      current = byTitle.get(heading) ?? 'summary';
      continue;
    }
    if (current === 'summary') {
      if (line !== 'No summary.') day.summary = day.summary ? `${day.summary} ${line}` : line;
    } else if (line.startsWith('- ')) {
      const item = clean(line);
      if (item) day[current].push(item);
    }
  }
  return day;
}

/**
 * The day after an update. An AI update rewrites the day: it was given the day so far and told to
 * keep its decisions (so the recorded gate decisions it rephrases are not listed twice). A
 * recorded-facts update only adds decisions and fills an empty summary, so it never overwrites what
 * the AI wrote.
 */
export function mergeDay(existing: StateDay | undefined, update: StateDay): StateDay {
  if (!existing || update.source === 'ai') return update;
  return {
    ...existing,
    summary: existing.summary || update.summary,
    decisions: union(existing.decisions, update.decisions),
  };
}

export function renderState(days: readonly StateDay[]): string {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const kept = sorted.slice(0, MAX_DAYS);
  const body = kept.map(formatDay).join('\n\n');
  // The decision timeline: every day's decisions in one list, newest day first.
  const decisions = kept
    .flatMap((d) => d.decisions.map((item) => `- **${d.date}** · ${item}`))
    .slice(0, MAX_TIMELINE);
  return [
    STATE_TITLE,
    '',
    '_What the arena decided and where it stands: the relevant points of the team’s discussions, not the chat itself. Key decisions first, then one section per day, newest first. Written by the arena’s AI; on days it could not, from the recorded decisions. Commits and stage moves are in [PROGRESS.md](PROGRESS.md)._',
    '',
    '## Key decisions',
    '',
    decisions.length ? decisions.join('\n') : 'None yet.',
    '',
    body || 'Nothing yet.',
    '',
  ].join('\n');
}

/** STATE.md with `update` merged into its day. */
export function mergeState(existing: string | null | undefined, update: StateDay): string {
  const days = parseState(existing);
  const old = days.find((d) => d.date === update.date);
  return renderState([mergeDay(old, update), ...days.filter((d) => d.date !== update.date)]);
}

/** The day's update from the recorded facts, used when the AI cannot write one. */
export function factsDay(date: string, facts: ProgressFacts): StateDay {
  const decisions = [
    ...facts.approvals.map((a) => decisionLine(a, false).replace(/^\d\d:\d\d UTC · /, '')),
    ...facts.moves
      .filter((m) => m.kind === 'send_back')
      .map(
        (m) =>
          `Sent back ${m.from ?? ''} → ${m.to} by ${m.actor ?? 'someone'}${m.reason ? `: ${oneLine(m.reason, 160)}` : ''}`,
      ),
  ];
  const moved = facts.moves.filter((m) => m.kind === 'advance' && m.from).at(-1);
  const summary = moved
    ? `${moved.from} was approved and the cycle moved to ${moved.to}.`
    : decisions.length
      ? 'Gate decisions were recorded.'
      : '';
  return {
    date,
    source: 'auto',
    summary,
    decisions: cleanList(decisions),
    discussed: [],
    questions: [],
  };
}

/**
 * The input of the state-log fork. How to summarise (rules, tools, tone) is the Pi summarize-state
 * skill's job; this is only the data (reason, facts, the day so far) and the format parseAiState reads.
 */
export function statePrompt(
  facts: ProgressFacts,
  trigger: ProgressTrigger,
  today: StateDay | undefined,
): string {
  const lines = [
    'Today’s STATE.md section.',
    trigger === 'gate'
      ? 'Reason: a stage gate was just approved.'
      : 'Reason: the team has been discussing a lot since the last update.',
    facts.since
      ? `Window: what was said since ${stamp(facts.since)}.`
      : 'Window: everything said so far.',
    '',
    'Facts recorded by the app:',
    `- Now: ${facts.cycle !== null ? `cycle ${facts.cycle}, stage ${facts.stage ?? '?'}` : 'no cycle yet'}`,
    `- Messages since: ${facts.humanMessages} from people, ${facts.aiMessages} from the AI`,
    ...facts.approvals.map((a) => `- ${decisionLine(a)}`),
    ...facts.moves
      .filter((m) => m.kind === 'send_back')
      .map(
        (m) =>
          `- Sent back ${m.from ?? ''} → ${m.to}${m.reason ? `: ${oneLine(m.reason, 160)}` : ''}`,
      ),
    ...[...new Set(facts.versions.map((v) => v.name))].map((name) => `- Document changed: ${name}`),
  ];
  if (today && (today.summary || today.decisions.length)) {
    lines.push(
      '',
      'Today’s section so far (keep its decisions unless they were reversed):',
      `SUMMARY: ${today.summary}`,
      'DECISIONS:',
      ...today.decisions.map((d) => `- ${d}`),
      'DISCUSSED:',
      ...today.discussed.map((d) => `- ${d}`),
      'OPEN QUESTIONS:',
      ...today.questions.map((d) => `- ${d}`),
    );
  }
  lines.push(
    '',
    'Reply in exactly this format and nothing else:',
    'Keep only what matters to the project: leave out greetings, small talk, thanks, repeated questions and back-and-forth.',
    'SUMMARY: <two or three lines: what the team worked on and where it landed today>',
    'DECISIONS:',
    '- <a decision the team made today: what, who decided, and any date or deadline agreed; or none>',
    'DISCUSSED:',
    '- <one line per major discussion: topic and outcome, with any timeline agreed; or none>',
    'OPEN QUESTIONS:',
    '- <a question still open, or none>',
  );
  return lines.join('\n');
}

const HEADS: Record<string, ListKey> = {
  DECISIONS: 'decisions',
  DISCUSSED: 'discussed',
  DISCUSSIONS: 'discussed',
  'OPEN QUESTIONS': 'questions',
  QUESTIONS: 'questions',
};

/** The AI's reply in the format above, or null when it does not follow it. */
export function parseAiState(
  text: string,
): Pick<StateDay, 'summary' | 'decisions' | 'discussed' | 'questions'> | null {
  const out = {
    summary: '',
    decisions: [] as string[],
    discussed: [] as string[],
    questions: [] as string[],
  };
  let current: ListKey | 'summary' | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^[#*_\s]+|[*_]+$/g, '').trim();
    if (!line) continue;
    // "SUMMARY: …", "**Decisions:**", "## Open questions" (a heading with no colon ends the line).
    const head =
      /^(SUMMARY|DECISIONS|DISCUSSED|DISCUSSIONS|OPEN QUESTIONS|QUESTIONS)[*_\s]*(?::[*_\s]*(.*))?$/i.exec(
        line,
      );
    if (head) {
      const name = (head[1] ?? '').toUpperCase();
      const rest = (head[2] ?? '').trim();
      current = name === 'SUMMARY' ? 'summary' : (HEADS[name] ?? null);
      if (current === 'summary' && rest) out.summary = rest;
      else if (current && current !== 'summary' && rest) out[current].push(rest);
      continue;
    }
    if (current === 'summary') out.summary = out.summary ? `${out.summary} ${line}` : line;
    else if (current) out[current].push(line);
  }
  const summary = oneLine(out.summary, 800);
  if (!summary) return null;
  return {
    summary,
    decisions: cleanList(out.decisions),
    discussed: cleanList(out.discussed),
    questions: cleanList(out.questions),
  };
}

/**
 * The days of the old AI-written progress log (before STATE.md), so its summaries, decisions and
 * discussions move into STATE.md: one day per date, entries joined oldest first.
 */
export function legacyStateDays(oldLog: string | null | undefined): StateDay[] {
  if (!oldLog?.startsWith(`${LEGACY_LOG_TITLE}\n`)) return [];
  const marks = [...oldLog.matchAll(/^<!-- progress-entry id=[^\s]+ at=([^\s]+) -->$/gm)];
  const days = new Map<string, StateDay>();
  for (const [i, m] of [...marks.entries()].reverse()) {
    const text = oldLog.slice((m.index ?? 0) + m[0].length, marks[i + 1]?.index ?? oldLog.length);
    const date = dayOf(m[1] ?? '');
    const lists: Record<string, string[]> = { Decisions: [], Discussions: [], Timeline: [] };
    let current: string | null = null;
    let summary = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('## ') || /^_.*_$/.test(line)) continue;
      const heading = /^\*\*(.+)\*\*$/.exec(line)?.[1];
      if (heading && heading in lists) current = heading;
      else if (current && line.startsWith('- ')) lists[current]?.push(clean(line));
      else if (!current) summary = summary ? `${summary} ${line}` : line;
    }
    const day = days.get(date) ?? {
      date,
      source: 'ai' as const,
      summary: '',
      decisions: [],
      discussed: [],
      questions: [],
    };
    days.set(date, {
      ...day,
      summary: oneLine([day.summary, summary].filter(Boolean).join(' '), 800),
      decisions: union(day.decisions, cleanList(lists.Decisions ?? [])),
      discussed: union(day.discussed, cleanList(lists.Discussions ?? [])),
    });
  }
  return [...days.values()];
}
