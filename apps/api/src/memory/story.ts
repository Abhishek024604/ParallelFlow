import { md, stageName } from '../progress/activity-log.js';
import type { MemoryEdge, MemoryNode, NodeType } from './model.js';

// STATE.md: the arena's story, rendered from its memory graph and the nightly chapters (ADR-045).
// Pure; unit tested. The top sections are recomputed every night from the graph; the chapters are
// the nightly texts as written, oldest first, grouped by the stage they happened in, and are never
// rewritten (a later correction is a line of a later chapter). Layout:
//   title, "up to" line · The story so far · Ground rules · Key decisions · Who's who ·
//   Open threads · Needs confirmation · Chapters (Before the memory, then by stage) · Glossary
// docs/state/graph.json is the same graph for machines (coding agents, tools).

export const STORY_TITLE_PREFIX = '# The story of ';
export const STORY_MARKER = '<!-- memory-story -->';
export const STATE_DIR = 'docs/state';
export const GRAPH_PATH = `${STATE_DIR}/graph.json`;
export const LEGACY_PATH = `${STATE_DIR}/legacy.md`;
const MAX_DECISIONS = 60;

export type ChapterStatus = 'pending' | 'done' | 'quiet' | 'failed';

export interface Chapter {
  /** The arena's local day, yyyy-mm-dd. */
  day: string;
  status: ChapterStatus;
  title: string | null;
  chapter: string | null;
  stage: string | null;
  cycle: number | null;
}

export interface StoryInput {
  arenaName: string;
  /** The last day told (done, quiet or failed), or null before the first night. */
  upTo: string | null;
  /** The latest "story so far". */
  story: string | null;
  nodes: readonly MemoryNode[];
  /** Live edges. */
  edges: readonly MemoryEdge[];
  chapters: readonly Chapter[];
  /** The days of STATE.md as it was before the memory (date, summary), oldest first. */
  legacy: readonly { date: string; summary: string }[] | null;
}

export const isMemoryStory = (content: string | null | undefined): boolean =>
  !!content && content.includes(STORY_MARKER);

const CLOSED = new Set(['superseded', 'dropped']);

/** "14 Oct 2026". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14–18 Oct 2026", "30 Oct – 2 Nov 2026", "14 Oct 2026". */
export function dayRange(from: string, to: string): string {
  if (from === to) return shortDay(from);
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  const a = new Date(`${from}T12:00:00Z`);
  const day = (d: Date) => String(d.getUTCDate());
  const month = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  if (fy === ty && fm === tm) return `${day(a)}–${shortDay(to)}`;
  if (fy === ty) return `${day(a)} ${month(a)} – ${shortDay(to)}`;
  return `${shortDay(from)} – ${shortDay(to)}`;
}

/** One line of table-safe text. */
const cell = (value: string | null | undefined, max = 160): string => md(value ?? '', max) || '—';

const line = (value: string | null | undefined, max = 300): string => md(value ?? '', max);

function byKey(a: MemoryNode, b: MemoryNode): number {
  const n = (k: string) => Number(/-(\d+)$/.exec(k)?.[1] ?? 0);
  return n(a.key) - n(b.key) || a.key.localeCompare(b.key);
}

function graphIndex(input: StoryInput) {
  const byId = new Map(input.nodes.map((n) => [n.id, n]));
  const out = (id: string, type: string) =>
    input.edges
      .filter((e) => e.src === id && e.type === type)
      .map((e) => byId.get(e.dst))
      .filter((n): n is MemoryNode => !!n);
  const into = (id: string, type: string) =>
    input.edges
      .filter((e) => e.dst === id && e.type === type)
      .map((e) => byId.get(e.src))
      .filter((n): n is MemoryNode => !!n);
  return { out, into };
}

const live = (input: StoryInput, type: NodeType, open = false) =>
  input.nodes
    .filter((n) => n.type === type && !CLOSED.has(n.status))
    .filter((n) => !open || n.status === 'open')
    .sort(byKey);

/** "_(set by Asha, 21 Oct 2026)_" */
const credit = (verb: string, n: MemoryNode): string =>
  `_(${n.attrs.by ? `${verb} by ${line(n.attrs.by, 60)}, ` : ''}${shortDay(n.firstSeenDay)})_`;

function groundRules(input: StoryInput): string {
  const rules = live(input, 'Instruction').filter((n) => !n.attrs.needs_confirmation);
  if (!rules.length) return 'None yet.';
  return rules
    .map(
      (n) =>
        `- **${n.key}** · ${line(n.title)}${n.summary ? `. ${line(n.summary)}` : ''} ${credit('set', n)}`,
    )
    .join('\n');
}

function decisions(input: StoryInput, g: ReturnType<typeof graphIndex>): string {
  const rows = input.nodes
    .filter((n) => n.type === 'Decision' && n.status !== 'dropped')
    .sort(byKey)
    .reverse();
  if (!rows.length) return 'None yet.';
  const shown = rows.slice(0, MAX_DECISIONS);
  const table = [
    '| Key | Decision | Why | Who | Date | Status | Supersedes |',
    '|---|---|---|---|---|---|---|',
    ...shown.map((n) => {
      const who = g.out(n.id, 'DECIDED_BY').map((p) => p.title);
      const replaced = g.out(n.id, 'SUPERSEDES').map((o) => o.key);
      const status = n.attrs.needs_confirmation ? `${n.status} (unconfirmed)` : n.status;
      return `| ${n.key} | ${cell(n.title)} | ${cell(n.attrs.why ?? n.summary)} | ${cell(
        who.length ? who.join(', ') : (n.attrs.by ?? null),
        80,
      )} | ${shortDay(n.firstSeenDay)} | ${status} | ${replaced.length ? replaced.join(', ') : '—'} |`;
    }),
  ];
  if (rows.length > shown.length) {
    table.push(
      '',
      `_${rows.length - shown.length} older decisions are in [graph.json](${GRAPH_PATH})._`,
    );
  }
  return table.join('\n');
}

function people(input: StoryInput, g: ReturnType<typeof graphIndex>): string {
  const persons = input.nodes
    .filter((n) => n.type === 'Person' && n.status !== 'dropped')
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!persons.length) return 'Nobody yet.';
  return persons
    .map((p) => {
      const roles = p.attrs.roles?.length
        ? ` · ${p.attrs.roles.map((r) => line(r, 40)).join(', ')}`
        : '';
      const owns = g.out(p.id, 'OWNS').map((n) => line(n.title, 60));
      const decided = g
        .into(p.id, 'DECIDED_BY')
        .filter((n) => n.type === 'Decision')
        .map((n) => n.key);
      const assigned = g
        .into(p.id, 'ASSIGNED_TO')
        .filter((n) => !CLOSED.has(n.status) && n.status !== 'done')
        .map((n) => n.key);
      const parts = [
        owns.length ? `owns ${owns.join(', ')}` : null,
        decided.length ? `decided ${decided.join(', ')}` : null,
        assigned.length ? `working on ${assigned.join(', ')}` : null,
      ].filter(Boolean);
      return `- **${line(p.title, 60)}**${roles}${parts.length ? ` — ${parts.join('; ')}` : ''}`;
    })
    .join('\n');
}

function openThreads(input: StoryInput, g: ReturnType<typeof graphIndex>): string {
  const item = (n: MemoryNode, extra = '') =>
    `- **${n.key}** · ${line(n.title)}${n.summary ? ` — ${line(n.summary, 200)}` : ''}${extra} ${credit(
      'raised',
      n,
    )}`;
  const sections: string[] = [];
  const questions = live(input, 'Question', true);
  if (questions.length)
    sections.push(`### Questions\n\n${questions.map((n) => item(n)).join('\n')}`);
  const risks = live(input, 'Risk', true);
  if (risks.length) sections.push(`### Risks\n\n${risks.map((n) => item(n)).join('\n')}`);
  const actions = live(input, 'ActionItem', true);
  if (actions.length) {
    sections.push(
      `### Action items\n\n${actions
        .map((n) => {
          const who = g.out(n.id, 'ASSIGNED_TO').map((p) => p.title);
          return item(n, who.length ? ` → ${who.map((w) => line(w, 40)).join(', ')}` : '');
        })
        .join('\n')}`,
    );
  }
  return sections.length ? sections.join('\n\n') : 'Nothing open right now.';
}

function needsConfirmation(input: StoryInput): string {
  const items = input.nodes
    .filter((n) => n.attrs.needs_confirmation && !CLOSED.has(n.status))
    .sort((a, b) => a.type.localeCompare(b.type) || byKey(a, b));
  if (!items.length) return 'Nothing right now.';
  return [
    '_The AI was not sure about these. Confirm or correct them in the arena chat._',
    '',
    ...items.map(
      (n) => `- **${n.key}** · ${line(n.title)} (${n.type}, ${shortDay(n.firstSeenDay)})`,
    ),
  ].join('\n');
}

const FALLBACK_NOTE = '_Told from the recorded facts: the AI will retell this day._';

function chapters(input: StoryInput): string {
  const parts: string[] = [];
  if (input.legacy?.length) {
    parts.push(
      [
        '### Before the memory',
        '',
        `The arena's notes from before its memory, kept whole in [legacy.md](${LEGACY_PATH}).`,
        '',
        ...input.legacy.map((d) => `- **${shortDay(d.date)}** · ${line(d.summary, 600)}`),
      ].join('\n'),
    );
  }
  const told = [...input.chapters]
    .filter((c) => (c.status === 'done' || c.status === 'failed') && c.chapter)
    .sort((a, b) => a.day.localeCompare(b.day));
  // Consecutive days of the same cycle and stage make one chapter.
  const runs: Chapter[][] = [];
  for (const c of told) {
    const last = runs.at(-1)?.at(-1);
    if (last && last.stage === c.stage && last.cycle === c.cycle) runs.at(-1)?.push(c);
    else runs.push([c]);
  }
  runs.forEach((run, i) => {
    const first = run[0];
    const end = run.at(-1);
    if (!first || !end) return;
    const stage = first.stage ? stageName(first.stage) : 'Getting started';
    const cycle = first.cycle && first.cycle > 1 ? `Cycle ${first.cycle} · ` : '';
    const days = run.map((c) =>
      [
        `#### ${shortDay(c.day)}${c.title ? ` · ${line(c.title, 120)}` : ''}`,
        '',
        (c.chapter ?? '').trim(),
        ...(c.status === 'failed' ? ['', FALLBACK_NOTE] : []),
      ].join('\n'),
    );
    parts.push(
      [`### Chapter ${i + 1} · ${cycle}${stage} (${dayRange(first.day, end.day)})`, ...days].join(
        '\n\n',
      ),
    );
  });
  return parts.length
    ? parts.join('\n\n')
    : 'The first chapter is written after the arena’s first day ends.';
}

function glossary(input: StoryInput): string {
  const terms = live(input, 'Topic').sort((a, b) => a.title.localeCompare(b.title));
  if (!terms.length) return 'No terms yet.';
  return terms
    .map((n) => `- **${line(n.title, 80)}**${n.summary ? ` — ${line(n.summary, 300)}` : ''}`)
    .join('\n');
}

/** STATE.md. */
export function renderStory(input: StoryInput): string {
  const g = graphIndex(input);
  const up = input.upTo
    ? `> Up to ${shortDay(input.upTo)}. Written each night by the arena’s AI from its memory graph ([graph.json](${GRAPH_PATH})). Every change to the arena is in [PROGRESS.md](PROGRESS.md).`
    : '> Written each night by the arena’s AI from its memory graph. The first chapter comes after the arena’s first day ends. Every change to the arena is in [PROGRESS.md](PROGRESS.md).';
  return [
    `${STORY_TITLE_PREFIX}${md(input.arenaName, 80)}`,
    STORY_MARKER,
    '',
    up,
    '',
    '## The story so far',
    '',
    input.story?.trim() || 'Nothing to tell yet.',
    '',
    '## Ground rules',
    '',
    groundRules(input),
    '',
    '## Key decisions',
    '',
    decisions(input, g),
    '',
    '## Who’s who',
    '',
    people(input, g),
    '',
    '## Open threads',
    '',
    openThreads(input, g),
    '',
    '## Needs confirmation',
    '',
    needsConfirmation(input),
    '',
    '## Chapters',
    '',
    chapters(input),
    '',
    '## Glossary',
    '',
    glossary(input),
    '',
  ].join('\n');
}

export interface GraphSource {
  nodeId: string | null;
  edgeId: string | null;
  type: string;
  id: string;
}

/** docs/state/graph.json: the graph by readable ids ("Decision:D-001"); sources are ids only. */
export function renderGraphJson(input: {
  arenaName: string;
  upTo: string | null;
  nodes: readonly MemoryNode[];
  edges: readonly MemoryEdge[];
  sources: readonly GraphSource[];
}): string {
  const name = new Map(input.nodes.map((n) => [n.id, `${n.type}:${n.key}`]));
  const edgeName = new Map<string, string>();
  const edges = input.edges
    .filter((e) => name.has(e.src) && name.has(e.dst))
    .map((e) => {
      edgeName.set(e.id, `${name.get(e.src)} ${e.type} ${name.get(e.dst)}`);
      return { from: name.get(e.src), type: e.type, to: name.get(e.dst), confidence: e.confidence };
    });
  const sources: Record<string, { type: string; id: string }[]> = {};
  for (const s of input.sources) {
    const owner = s.nodeId ? name.get(s.nodeId) : s.edgeId ? edgeName.get(s.edgeId) : undefined;
    if (!owner) continue;
    (sources[owner] ??= []).push({ type: s.type, id: s.id });
  }
  const nodes = [...input.nodes]
    .sort((a, b) => a.type.localeCompare(b.type) || byKey(a, b))
    .map((n) => ({
      id: `${n.type}:${n.key}`,
      type: n.type,
      key: n.key,
      title: n.title,
      summary: n.summary,
      status: n.status,
      first_seen: n.firstSeenDay,
      last_seen: n.lastSeenDay,
      ...(n.attrs.why && { why: n.attrs.why }),
      ...(n.attrs.by && { by: n.attrs.by }),
      ...(n.attrs.roles?.length && { roles: n.attrs.roles }),
      ...(n.attrs.needs_confirmation && { needs_confirmation: true }),
    }));
  return `${JSON.stringify(
    { arena: input.arenaName, up_to: input.upTo, version: 1, nodes, edges, sources },
    null,
    2,
  )}\n`;
}
