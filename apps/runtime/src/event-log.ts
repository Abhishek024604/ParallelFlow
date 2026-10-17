import type { RuntimeEvent, RuntimeEventType } from '@saras/runtime-client';
import { TERMINAL_EVENTS } from '@saras/runtime-client';

// The per-turn event log behind the SSE stream (RIC streamTurnEvents). Events get seq 1, 2, 3, … and
// are kept in memory until the turn has been finished for the TTL, so a dropped stream can resume
// with Last-Event-ID. In memory only (SLICE_DEBT.md): a runtime restart loses unfinished streams.

export type EventListener = (event: RuntimeEvent) => void;

export class TurnEventLog {
  private readonly events: RuntimeEvent[] = [];
  private readonly listeners = new Set<EventListener>();
  private finishedAt: number | null = null;

  constructor(
    readonly sessionId: string,
    readonly turnId: string,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Appends an event. Ignored after a terminal event (a turn ends exactly once). */
  append(type: RuntimeEventType, data?: Record<string, unknown>): RuntimeEvent | null {
    if (this.finishedAt !== null) return null;
    const event: RuntimeEvent = {
      seq: this.events.length + 1,
      type,
      turn_id: this.turnId,
      session_id: this.sessionId,
      at: new Date(this.clock()).toISOString(),
      ...(data && { data }),
    };
    this.events.push(event);
    if (TERMINAL_EVENTS.has(type)) this.finishedAt = this.clock();
    for (const listener of this.listeners) listener(event);
    if (this.finishedAt !== null) this.listeners.clear();
    return event;
  }

  get finished(): boolean {
    return this.finishedAt !== null;
  }

  get size(): number {
    return this.events.length;
  }

  /** Events with seq > after (after = Last-Event-ID; 0 or undefined = all). */
  since(after = 0): RuntimeEvent[] {
    return this.events.slice(Math.max(0, after));
  }

  /** Live events from now on. Returns the unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    if (this.finished) return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** True once the turn has been finished for longer than ttlMs. */
  expired(ttlMs: number): boolean {
    return this.finishedAt !== null && this.clock() - this.finishedAt > ttlMs;
  }
}

/** Parses Last-Event-ID: a non-negative integer seq, else 0. */
export function parseLastEventId(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !/^\d{1,9}$/.test(value)) return 0;
  return Number(value);
}

/** One SSE frame: `id: <seq>`, `event: <type>`, `data: <RuntimeEvent JSON>`. */
export function sseFrame(event: RuntimeEvent): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
