import { isTimeZone } from '@parallelflow/contracts';

// When an arena's day is told (ADR-045). A day D ends at midnight in the arena's own time zone; its
// chapter is written from 00:30 local on D+1 (half an hour for late messages), and missed days are
// caught up, at most MAX_CATCH_UP of them, oldest first. Wall-clock arithmetic goes through Intl,
// so daylight-saving changes need no special case. Pure; unit tested.

export const DAY_GRACE_MINUTES = 30;
export const MAX_CATCH_UP = 7;

const zoneOf = (timezone: string): string => (isTimeZone(timezone) ? timezone : 'UTC');

/** The local date and minute of the day of `now` in `timezone`. */
export function localClock(now: Date, timezone: string): { day: string; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zoneOf(timezone),
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** yyyy-mm-dd plus `n` days (calendar arithmetic, no zone). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The latest local day whose chapter may be written now: yesterday once it is 00:30 locally. */
export function dueDay(now: Date, timezone: string): string {
  const { day, minute } = localClock(now, timezone);
  return addDays(day, minute < DAY_GRACE_MINUTES ? -2 : -1);
}

/**
 * The days to write now, oldest first: those after `lastDay` up to the due day, at most
 * MAX_CATCH_UP. The first run (no last day) tells the last MAX_CATCH_UP days, never before `since`
 * (the arena's first day).
 */
export function daysToRun(
  now: Date,
  timezone: string,
  lastDay: string | null,
  since?: string | null,
): string[] {
  const due = dueDay(now, timezone);
  const floor = addDays(due, -(MAX_CATCH_UP - 1));
  let from = lastDay ? addDays(lastDay, 1) : floor;
  if (from < floor) from = floor;
  if (since && from < since) from = since;
  const days: string[] = [];
  for (let d = from; d <= due; d = addDays(d, 1)) days.push(d);
  return days;
}
