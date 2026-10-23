// The arena's project log, progress.md (pure: formatting, merging, parsing; unit tested).
//
// progress.md is purely factual: it is built by the app from what was recorded (git commits with
// their authors and the stage they landed in, stage moves, approvals and their deciders, pushes, new
// and approved versions with their authors). No AI writes it and no chat goes in it, so it is always
// accurate. What the team discussed and decided lives in state.md (state-log.ts).
//
// The file is the arena's `progress` artifact (a new version per update) and the repo root's
// progress.md. Layout: title, where the cycle is now, the Timeline (commits and stage moves grouped
// by date, newest first; each commit with its author and stage), then the Log: one section per entry
// (written after every approved gate and after a busy stretch of discussion), newest first. Each entry starts with a marker line
// `<!-- progress-entry id=<id> at=<iso> -->` so entries can be found and replaced (same id) without
// parsing the prose. The repo copy has the markers stripped.

export type ProgressTrigger = 'gate' | 'messages';

export interface StageMove {
  at: string;
  cycle: number;
  from: string | null;
  to: string;
  kind: string;
  actor: string | null;
  reason: string | null;
}

export interface GateDecision {
  at: string;
  stage: string;
  status: string;
  summary: string | null;
  document: string | null;
  /** Who voted for the outcome, in vote order. */
  deciders: string[];
  /** The reasons given with the deciding votes (a rejection's why). */
  reasons: string[];
}

/** What the record shows in a window (names and numbers only, no message text). */
export interface ProgressFacts {
  since: string | null;
  until: string;
  cycle: number | null;
  stage: string | null;
  moves: StageMove[];
  approvals: GateDecision[];
  /** New versions of arena documents (pushes included), oldest first. */
  versions: {
    at: string;
    name: string;
    version: number;
    /** "Asha", "AI", "AI for Asha". */
    author: string;
    /** For a push: the Private version it was copied from (0 when unknown). */
    pushedFrom: number | null;
  }[];
  /** Versions approved in the window. */
  approvedVersions: { at: string; name: string; version: number; by: string | null }[];
  humanMessages: number;
  aiMessages: number;
}

export interface CommitFact {
  sha: string;
  message: string;
  author: string;
  at: string;
}

export interface ProgressEntry {
  id: string;
  /** ISO timestamp (database clock). */
  at: string;
  trigger: ProgressTrigger;
  facts: ProgressFacts;
  /** Repo commits not yet listed in another entry. */
  commits: CommitFact[];
}

export const LOG_TITLE = '# Progress';
/** The title of the old, AI-written log (before state.md); its entries move to state.md. */
export const LEGACY_LOG_TITLE = '# Progress log';
export const MAX_ENTRIES = 100;
const MAX_LINE = 300;
/** Repo commits that only refresh the two log files are not listed. */
export const HOUSEKEEPING_COMMIT = /^Update (progress|logs)\b/;

const MARKER_GLOBAL = /^<!-- progress-entry id=([^\s]+) at=([^\s]+) -->$/gm;
const LISTED_SHA = /^- `([0-9a-f]{7})`/gm;
/** An entry's commit line: "- `sha` message · author[ · STAGE] · yyyy-mm-dd hh:mm UTC". */
const COMMIT_LINE =
  /^- `([0-9a-f]{7})` (.*?) · ([^·\n]+?)(?: · (?:PLAN|DESIGN|BUILD|TEST|DEPLOY|MAINTAIN))? · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) UTC$/gm;

export const oneLine = (text: string, max = MAX_LINE): string => {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
};

/** "2026-10-18 14:02 UTC" */
export function stamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** "14:02 UTC" */
const clock = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** "2026-10-18" (UTC). */
export const dayOf = (iso: string): string => iso.slice(0, 10);

const MOVE_WORD: Record<string, string> = {
  advance: 'approved',
  send_back: 'sent back',
  open: 'opened',
  auto: 'moved',
  skip: 'skipped',
};

export function moveLine(m: StageMove, withDate = true): string {
  const step = m.from ? `${m.from} → ${m.to}` : m.to;
  const why = m.reason ? ` (${oneLine(m.reason, 160)})` : '';
  const when = withDate ? stamp(m.at) : clock(m.at);
  return `${when} · Cycle ${m.cycle} · ${step} · ${MOVE_WORD[m.kind] ?? m.kind} by ${m.actor ?? 'someone'}${why}`;
}

/**
 * The stage the arena was in at `iso`: the target of the last stage move at or before it. Before the
 * first move the cycle was at PLAN; with no moves recorded, the current stage.
 */
export function stageAt(moves: readonly StageMove[], iso: string, current: string | null): string {
  let last: StageMove | undefined;
  for (const m of moves) if (m.at <= iso && (!last || m.at >= last.at)) last = m;
  if (last) return last.to;
  return moves.length ? 'PLAN' : (current ?? 'PLAN');
}

const names = (list: string[]): string =>
  list.length <= 1 ? (list[0] ?? 'someone') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

export function decisionLine(a: GateDecision, withDate = true): string {
  const ok = a.status === 'approved';
  const when = withDate ? stamp(a.at) : clock(a.at);
  const doc = a.document ? `, with ${a.document}` : '';
  const why = ok
    ? a.summary
      ? `: ${oneLine(a.summary, 160)}`
      : ''
    : a.reasons.length
      ? `: ${oneLine(a.reasons.join('; '), 160)}`
      : '';
  return `${when} · ${a.stage} gate ${ok ? 'approved' : 'not approved'} by ${names(a.deciders)}${doc}${why}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The entry's title: what happened. */
function entryTitle(entry: ProgressEntry): string {
  if (entry.trigger === 'gate') {
    const gate = entry.facts.approvals.filter((a) => a.status === 'approved').at(-1);
    return gate ? `${gate.stage} gate approved` : 'Gate approved';
  }
  return 'Team discussion';
}

/**
 * One entry as Markdown (marker, heading, then a list per kind of fact that has any; commits first).
 * `stageOf` names the stage a commit landed in.
 */
export function formatEntry(
  entry: ProgressEntry,
  stageOf: (iso: string) => string = () => entry.facts.stage ?? 'PLAN',
): string {
  const f = entry.facts;
  const where = f.cycle !== null ? ` · Cycle ${f.cycle}${f.stage ? ` · ${f.stage}` : ''}` : '';
  const why = entry.trigger === 'gate' ? 'After a gate approval' : 'After team discussion';
  const covers = f.since ? `since ${stamp(f.since)}` : 'from the start';

  const updates: string[] = [];
  for (const m of f.moves) {
    if (m.kind === 'advance' && m.from) updates.push(`The cycle moved ${m.from} → ${m.to}.`);
    if (m.kind === 'send_back') updates.push(`The cycle was sent back ${m.from ?? ''} → ${m.to}.`);
    if (m.kind === 'open') updates.push(`Cycle ${m.cycle} started at ${m.to}.`);
  }
  if (f.versions.length) {
    const docs = new Set(f.versions.map((v) => v.name)).size;
    updates.push(`${plural(f.versions.length, 'new version')} across ${plural(docs, 'document')}.`);
  }

  const section = (title: string, items: string[]) =>
    items.length ? `\n\n**${title}**\n\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  const pushes = f.versions
    .filter((v) => v.pushedFrom !== null)
    .map(
      (v) =>
        `${v.name} · ${v.pushedFrom ? `Private v${v.pushedFrom}` : 'Private'} → arena v${v.version} · by ${v.author} · ${stamp(v.at)}`,
    );
  const versions = f.versions
    .filter((v) => v.pushedFrom === null)
    .map((v) => `${v.name} v${v.version} · by ${v.author} · ${stamp(v.at)}`);
  const approved = f.approvedVersions.map(
    (v) => `${v.name} v${v.version} · approved by ${v.by ?? 'someone'} · ${stamp(v.at)}`,
  );
  const gates = [
    ...f.approvals.map((a) => ({ at: a.at, line: decisionLine(a) })),
    ...f.moves.map((m) => ({ at: m.at, line: moveLine(m) })),
  ]
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((g) => g.line);
  const commits = entry.commits.map(
    (c) =>
      `\`${c.sha.slice(0, 7)}\` ${oneLine(c.message, 160)} · ${c.author} · ${stageOf(c.at)} · ${stamp(c.at)}`,
  );

  return [
    `<!-- progress-entry id=${entry.id} at=${entry.at} -->`,
    `### ${stamp(entry.at)}${where} · ${entryTitle(entry)}`,
    '',
    `_${why} · covers ${covers}_`,
  ]
    .join('\n')
    .concat(section('Commits', commits))
    .concat(section('Updates', updates))
    .concat(section('Approvals and stage moves', gates))
    .concat(section('Files pushed', pushes))
    .concat(section('New versions', versions))
    .concat(section('Approved versions', approved));
}

export interface LoggedEntry {
  id: string;
  at: string;
  /** The entry's Markdown, marker included. */
  text: string;
}

/** The entries of a progress.md in document order (newest first); none for the legacy log. */
export function parseLog(content: string | null | undefined): LoggedEntry[] {
  if (!content || isLegacyLog(content)) return [];
  const start = content.indexOf('\n## Log');
  const body = start >= 0 ? content.slice(start) : content;
  const marks = [...body.matchAll(MARKER_GLOBAL)];
  return marks.map((m, i) => {
    const from = m.index ?? 0;
    const to = marks[i + 1]?.index ?? body.length;
    return { id: m[1] ?? '', at: m[2] ?? '', text: body.slice(from, to).trim() };
  });
}

/** Whether a progress artifact still holds the old AI-written log. */
export const isLegacyLog = (content: string | null | undefined): boolean =>
  Boolean(content?.startsWith(`${LEGACY_LOG_TITLE}\n`));

/** When the newest entry other than `exceptId` was written (the start of the next window). */
export function lastEntryAt(content: string | null | undefined, exceptId?: string): string | null {
  return parseLog(content).find((e) => e.id !== exceptId)?.at ?? null;
}

/** Short shas already listed by entries other than `exceptId`. */
export function listedCommits(content: string | null | undefined, exceptId?: string): Set<string> {
  const out = new Set<string>();
  for (const e of parseLog(content)) {
    if (e.id === exceptId) continue;
    for (const m of e.text.matchAll(LISTED_SHA)) out.add(m[1] ?? '');
  }
  return out;
}

/**
 * The repo commits an entry lists: not a log refresh, not listed by another entry, and not older
 * than the oldest entry kept (so commits of entries that fell off the end do not come back).
 */
export function commitsForEntry(
  content: string | null | undefined,
  entryId: string,
  commits: readonly CommitFact[],
): CommitFact[] {
  const listed = listedCommits(content, entryId);
  const others = parseLog(content).filter((e) => e.id !== entryId);
  const oldest = others.length >= MAX_ENTRIES ? others.at(-1)?.at : undefined;
  return commits
    .filter(
      (c) =>
        !HOUSEKEEPING_COMMIT.test(c.message) &&
        !listed.has(c.sha.slice(0, 7)) &&
        (!oldest || c.at >= oldest),
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export interface ProgressContext {
  current: { number: number; stage: string; status: string } | null;
  /** Every stage move and gate decision so far (the Timeline). */
  moves: StageMove[];
  decisions: GateDecision[];
}

/** The commits the entries list (sha, message, author, time), oldest first. */
export function loggedCommits(entries: readonly LoggedEntry[]): CommitFact[] {
  const out: CommitFact[] = [];
  for (const e of entries) {
    for (const m of e.text.matchAll(COMMIT_LINE)) {
      const at = `${(m[4] ?? '').replace(' ', 'T')}:00.000Z`;
      out.push({ sha: m[1] ?? '', message: m[2] ?? '', author: (m[3] ?? '').trim(), at });
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * The Timeline: every commit (with its author and the stage it landed in) and every stage move,
 * grouped by date, newest date first, in time order within a day.
 */
export function renderTimeline(
  ctx: Pick<ProgressContext, 'moves' | 'decisions'> & { current?: ProgressContext['current'] },
  commits: readonly CommitFact[] = [],
): string {
  const current = ctx.current?.stage ?? null;
  const items = [
    ...commits.map((c) => ({
      at: c.at,
      line: `${clock(c.at)} · ${stageAt(ctx.moves, c.at, current)} · \`${c.sha.slice(0, 7)}\` ${oneLine(c.message, 160)} · by ${c.author}`,
    })),
    ...ctx.moves.map((m) => ({ at: m.at, line: moveLine(m, false) })),
    // An approval already shows as its stage move; a rejection has no move of its own.
    ...ctx.decisions
      .filter((d) => d.status !== 'approved')
      .map((d) => ({ at: d.at, line: decisionLine(d, false) })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  if (!items.length) return 'Nothing yet.';
  const days = new Map<string, string[]>();
  for (const item of items) {
    const day = dayOf(item.at);
    days.set(day, [...(days.get(day) ?? []), `- ${item.line}`]);
  }
  return [...days.entries()]
    .reverse()
    .map(([day, lines]) => `### ${day}\n\n${lines.join('\n')}`)
    .join('\n\n');
}

/** The whole progress.md from its context and entries (newest first, at most MAX_ENTRIES). */
export function renderProgress(ctx: ProgressContext, entries: readonly LoggedEntry[]): string {
  const now = ctx.current
    ? `Cycle ${ctx.current.number} · ${ctx.current.stage} (${ctx.current.status})`
    : 'No cycle yet.';
  const kept = [...entries]
    .sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? 1 : -1))
    .slice(0, MAX_ENTRIES);
  const log = kept.map((e) => e.text).join('\n\n');
  return [
    LOG_TITLE,
    '',
    '_The arena’s project log, kept by the app from the record: git commits with their authors and stages, stage moves and approvals, pushes and versions. Newest first. What the team discussed and decided is in [state.md](state.md)._',
    '',
    `**Now:** ${now}`,
    '',
    '## Timeline',
    '',
    renderTimeline(ctx, loggedCommits(kept)),
    '',
    '## Log',
    '',
    log || 'No entries yet.',
    '',
  ].join('\n');
}

/** progress.md with `entry` added (or replacing the entry with the same id). */
export function mergeLog(
  existing: string | null | undefined,
  ctx: ProgressContext,
  entry: ProgressEntry,
): string {
  const others = parseLog(existing).filter((e) => e.id !== entry.id);
  const stageOf = (iso: string) => stageAt(ctx.moves, iso, ctx.current?.stage ?? null);
  return renderProgress(ctx, [
    { id: entry.id, at: entry.at, text: formatEntry(entry, stageOf) },
    ...others,
  ]);
}

/** A log file as committed to the repo: the entry markers removed. */
export const publicCopy = (content: string): string =>
  content.replace(/^<!-- (progress-entry|state-day) [^\n]*-->\n/gm, '');
