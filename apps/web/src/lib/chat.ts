import type { ArenaMessage } from '@saras/contracts';

// Pure helpers for the arena stream: merging polled pages and labelling days and times.

/** Oldest first by (created_at, id). created_at is fixed-width UTC with microseconds. */
function compare(a: ArenaMessage, b: ArenaMessage): number {
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * `current` plus the messages of `incoming` it does not have yet (by id), in stream order. Returns
 * `current` itself when nothing is new, so React can skip the render.
 */
export function mergeMessages(
  current: readonly ArenaMessage[],
  incoming: readonly ArenaMessage[],
): readonly ArenaMessage[] {
  const known = new Set(current.map((m) => m.id));
  const fresh = incoming.filter((m) => !known.has(m.id));
  if (fresh.length === 0) return current;
  const last = current.at(-1);
  const sorted = [...fresh].sort(compare);
  const first = sorted[0];
  // The usual case: everything new is newer than what we have.
  if (!last || (first && compare(last, first) < 0)) return [...current, ...sorted];
  return [...current, ...sorted].sort(compare);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today", "Yesterday", or "Mon 12 Oct" (with the year when it is not this year). Local time. */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (sameDay(date, now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
}

/** "10:02" in local time. */
export function timeLabel(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** Local calendar day, for grouping messages under one divider. */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
