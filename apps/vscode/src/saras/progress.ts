// Milestone events to the arena (POST …/coding-sessions/:id/events). "progress" is debounced so a
// busy agent sends one summary per window; tests/blocked/done go out at once. Summaries are counts
// and outcomes only, never file contents, diffs or command text.
import type { ProgressEvent } from './api.js';
import { type Clock, systemClock } from '../approvals/broker.js';

export class ProgressReporter {
  private pending: ProgressEvent | undefined;
  private timer: unknown;
  private lastSent = '';

  constructor(
    private readonly send: (e: ProgressEvent) => Promise<void>,
    private readonly debounceMs = 30_000,
    private readonly clock: Clock = systemClock,
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  report(kind: ProgressEvent['kind'], summary: string): void {
    const event: ProgressEvent = { kind, summary: summary.trim().slice(0, 500) || kind };
    if (kind === 'progress') {
      this.pending = event;
      if (this.timer === undefined) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = undefined;
          this.flush();
        }, this.debounceMs);
      }
      return;
    }
    if (kind === 'done') this.cancelPending();
    else this.flush();
    this.dispatch(event);
  }

  /** Send the pending progress summary now (for example before a push). */
  flush(): void {
    const e = this.pending;
    this.cancelPending();
    if (e) this.dispatch(e);
  }

  dispose(): void {
    this.cancelPending();
  }

  private cancelPending(): void {
    this.pending = undefined;
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private dispatch(e: ProgressEvent): void {
    const key = `${e.kind}:${e.summary}`;
    if (key === this.lastSent) return;
    this.lastSent = key;
    this.send(e).catch(this.onError);
  }
}

export function progressSummary(stats: {
  edits: number;
  commands: number;
  files: Set<string>;
}): string {
  const files = stats.files.size;
  const parts = [
    `${files} file${files === 1 ? '' : 's'} changed`,
    `${stats.commands} command${stats.commands === 1 ? '' : 's'} run`,
  ];
  return `Working: ${parts.join(', ')}.`;
}

const TEST_COMMAND =
  /\b(test|tests|vitest|jest|pytest|mocha|go test|cargo test|tsc|typecheck|lint)\b/;

export function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command);
}
