import type { ArenaTurnStreamEvent } from '@saras/contracts';

// In-memory fan-out of a running turn's live text to SSE subscribers on this API instance
// (SLICE_DEBT.md: single instance until Redis pub/sub). A late subscriber first gets the text so far,
// then live deltas, then the final status. Finished turns are kept briefly for clients that connect
// late. Text is never logged.

type StatusEvent = Extract<ArenaTurnStreamEvent, { type: 'status' }>;
type Listener = (event: ArenaTurnStreamEvent) => void;

interface Entry {
  text: string;
  final?: StatusEvent;
  listeners: Set<Listener>;
}

export class TurnBroadcaster {
  private readonly turns = new Map<string, Entry>();

  constructor(private readonly retainMs = 60_000) {}

  open(turnId: string): void {
    if (!this.turns.has(turnId)) this.turns.set(turnId, { text: '', listeners: new Set() });
  }

  delta(turnId: string, text: string): void {
    const entry = this.turns.get(turnId);
    if (!entry || entry.final || !text) return;
    entry.text += text;
    for (const listener of entry.listeners) listener({ type: 'delta', text });
  }

  finish(turnId: string, final: StatusEvent): void {
    const entry = this.turns.get(turnId);
    if (!entry || entry.final) return;
    entry.final = final;
    for (const listener of entry.listeners) listener(final);
    entry.listeners.clear();
    setTimeout(() => this.turns.delete(turnId), this.retainMs).unref();
  }

  /** Replays the turn so far, then follows it. Undefined when this instance does not know the turn. */
  subscribe(turnId: string, listener: Listener): (() => void) | undefined {
    const entry = this.turns.get(turnId);
    if (!entry) return undefined;
    if (entry.text) listener({ type: 'delta', text: entry.text });
    if (entry.final) {
      listener(entry.final);
      return () => undefined;
    }
    entry.listeners.add(listener);
    return () => entry.listeners.delete(listener);
  }
}

/** 30 AI turns per minute per user (doc 07 §7.1), in memory (SLICE_DEBT.md). */
export class AiTurnLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = Date.now,
  ) {}

  tryTake(userId: string): boolean {
    const now = this.clock();
    const recent = (this.hits.get(userId) ?? []).filter((at) => at > now - this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(userId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(userId, recent);
    return true;
  }
}
