import { actorLabel, type ActivityEvent, describe } from '../progress/activity-log.js';
import type { DeltaItem } from './resolver.js';
import { shortDay } from './story.js';

// The two inputs of a night's work (ADR-045) and the reply formats they ask for. How to read a day
// and how to tell it (rules, tone, the JSON schema) is in the Pi skills extract-memory and
// narrate-day (packages/pi-parallelflow/skills); these are only the data. The text goes to the
// arena's own AI and is never logged. Pure; unit tested.

export const MAX_MESSAGE_CHARS = 800;
export const MAX_MESSAGES_CHARS = 40_000;
export const MAX_FILE_CHARS = 600;
export const MAX_FILES = 6;
export const MAX_KNOWN = 150;

export interface DayMessage {
  ref: string;
  /** Local "HH:MM". */
  time: string;
  author: string;
  ai: boolean;
  text: string;
}

export interface DayFact {
  ref: string;
  time: string;
  line: string;
}

export interface DayFile {
  ref: string;
  name: string;
  version: number;
  excerpt: string;
}

export interface DayPull {
  ref: string;
  number: number;
  title: string;
  state: string;
  excerpt: string;
}

export interface KnownItem {
  type: string;
  key: string;
  title: string;
  status: string;
}

export interface DayMaterial {
  arenaName: string;
  day: string;
  timezone: string;
  stage: string | null;
  cycle: number | null;
  messages: readonly DayMessage[];
  events: readonly DayFact[];
  files: readonly DayFile[];
  pulls: readonly DayPull[];
  known: readonly KnownItem[];
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** An event as a plain fact ("Asha (Owner) approved Design gate · 2/2"), no markdown. */
export function factOf(e: ActivityEvent): string {
  const d = describe(e);
  const plain = (s: string) => s.replace(/\*\*/g, '').replace(/\\([\\`*_[\]<>|#~])/g, '$1');
  return plain(
    [actorLabel(e), d.verb, d.object ?? '', ...(d.details ?? []).filter(Boolean)]
      .filter((p) => p)
      .join(' ')
      .replace(/\s+/g, ' '),
  );
}

function header(m: DayMaterial, what: string): string[] {
  const now =
    m.cycle !== null ? `cycle ${m.cycle}, stage ${m.stage ?? '?'}` : 'no cycle started yet';
  return [
    `${what} for ${shortDay(m.day)} (${m.timezone}). Arena: ${m.arenaName}. Where it stands: ${now}.`,
  ];
}

/** The extract-memory input: the day's material with citable refs and the items already known. */
export function extractPrompt(m: DayMaterial): string {
  const lines = header(m, 'Memory extraction');
  lines.push(
    'Read the day below and reply with only the JSON object the skill describes. Cite refs (M, E, F, P) for every item.',
    '',
    'KNOWN ITEMS (reuse their keys; never create them again):',
    ...(m.known.length
      ? m.known
          .slice(0, MAX_KNOWN)
          .map((k) => `- ${k.type} ${k.key} · ${oneLine(k.title, 120)} (${k.status})`)
      : ['- none yet']),
    '',
    'MESSAGES:',
  );
  let budget = MAX_MESSAGES_CHARS;
  let cut = 0;
  for (const msg of m.messages) {
    const text = oneLine(msg.text, MAX_MESSAGE_CHARS);
    if (budget - text.length < 0) {
      cut += 1;
      continue;
    }
    budget -= text.length;
    lines.push(`${msg.ref} · ${msg.time} · ${msg.ai ? 'AI' : msg.author}: ${text}`);
  }
  if (!m.messages.length) lines.push('- none');
  if (cut) lines.push(`(${cut} later messages left out for length)`);
  lines.push('', 'EVENTS RECORDED BY THE APP:');
  lines.push(
    ...(m.events.length ? m.events.map((e) => `${e.ref} · ${e.time} · ${e.line}`) : ['- none']),
  );
  lines.push('', 'FILES APPROVED OR UPDATED (start of their text):');
  lines.push(
    ...(m.files.length
      ? m.files
          .slice(0, MAX_FILES)
          .map((f) => `${f.ref} · ${f.name} v${f.version}: ${oneLine(f.excerpt, MAX_FILE_CHARS)}`)
      : ['- none']),
  );
  lines.push('', 'PULL REQUESTS:');
  lines.push(
    ...(m.pulls.length
      ? m.pulls.map(
          (p) =>
            `${p.ref} · #${p.number} ${oneLine(p.title, 160)} (${p.state})${p.excerpt ? `: ${oneLine(p.excerpt, 400)}` : ''}`,
        )
      : ['- none']),
  );
  return lines.join('\n');
}

/** The same input, after a reply that did not validate: once, with what was wrong. */
export function repairPrompt(original: string, error: string): string {
  return `${original}\n\nYOUR PREVIOUS REPLY WAS NOT VALID (${oneLine(error, 400)}). Reply again with only the JSON object, exactly as the skill describes.`;
}

const DELTA_WORDS: Record<DeltaItem['change'], string> = {
  new: 'new',
  updated: 'updated',
  superseded: 'replaced',
  status: 'now',
};

/** One memory change as a line ("new Decision D-004 · Use Postgres — …"). */
export function deltaLine(d: DeltaItem): string {
  const head =
    d.change === 'status'
      ? `${d.type} ${d.key} is now ${d.status}`
      : `${DELTA_WORDS[d.change]} ${d.type} ${d.key}`;
  const replaced = d.replaced
    ? ` (replaces ${d.replaced.key} · ${oneLine(d.replaced.title, 80)})`
    : '';
  const unsure = d.needsConfirmation ? ' [unconfirmed]' : '';
  return `- ${head} · ${oneLine(d.title, 160)}${d.summary ? ` — ${oneLine(d.summary, 240)}` : ''}${replaced}${unsure}`;
}

/** The narrate-day input: what changed in the memory, the day's facts, and the story so far. */
export function narratePrompt(
  m: DayMaterial,
  delta: readonly DeltaItem[],
  story: string | null,
  counts: { people: number; ai: number },
): string {
  return [
    ...header(m, 'Chapter'),
    '',
    'THE STORY SO FAR (rewrite it so it includes this day):',
    story?.trim() || '(nothing yet: this is the first chapter)',
    '',
    'WHAT CHANGED IN THE MEMORY THIS DAY:',
    ...(delta.length ? delta.map(deltaLine) : ['- nothing new']),
    '',
    'FACTS RECORDED BY THE APP:',
    ...(m.events.length ? m.events.map((e) => `- ${e.time} · ${e.line}`) : ['- none']),
    `- Messages: ${counts.people} from people, ${counts.ai} from the AI`,
    '',
    'Reply in exactly this format and nothing else:',
    'TITLE: <a few words naming the day>',
    'CHAPTER:',
    '<one to four paragraphs telling the day>',
    'STORY:',
    '<three to five paragraphs: the whole story so far, including this day>',
  ].join('\n');
}

export interface Narration {
  title: string;
  chapter: string;
  story: string;
}

/** The narrate-day reply, or null when it does not follow the format. */
export function parseNarration(reply: string | null | undefined): Narration | null {
  if (!reply) return null;
  const text = reply.replace(/\r\n/g, '\n');
  const title = /^\W*TITLE\W*:\s*(.+)$/im.exec(text)?.[1];
  const chapterAt = /^\W*CHAPTER\W*:?[ \t]*$/im.exec(text);
  const storyAt = /^\W*STORY\W*:?[ \t]*$/im.exec(text);
  if (!title || !chapterAt || !storyAt || storyAt.index < chapterAt.index) return null;
  const chapter = text.slice(chapterAt.index + chapterAt[0].length, storyAt.index).trim();
  const story = text.slice(storyAt.index + storyAt[0].length).trim();
  if (!chapter || !story) return null;
  return {
    title: oneLine(title.replace(/[*_#]/g, ''), 120),
    chapter: chapter.slice(0, 6000),
    story: story.slice(0, 6000),
  };
}

/** A day told from the facts alone (the AI could not): what the memory and the app recorded. */
export function factsChapter(
  delta: readonly DeltaItem[],
  events: readonly DayFact[],
): { title: string; chapter: string } {
  const lines = [
    ...delta.slice(0, 20).map(deltaLine),
    ...events.slice(0, 20).map((e) => `- ${e.time} · ${e.line}`),
  ];
  return {
    title: 'What was recorded',
    chapter: lines.length ? lines.join('\n') : 'The team was at work; nothing was recorded.',
  };
}
