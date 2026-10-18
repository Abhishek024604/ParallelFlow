// Pending approvals and questions from the agent. Each request resolves exactly once: from the
// sidebar card, the modal fallback, or the timeout (which denies). Timers are injectable for tests.
import type { Decision } from '../shared/protocol.js';

export type ApprovalKind = 'command' | 'edit' | 'question' | 'confirm';

export interface ApprovalRequest {
  id: string;
  kind: ApprovalKind;
  title: string;
  /** Exact command (command), folder-relative path (edit), or question text. */
  detail: string;
  cwd?: string;
  reason?: string;
  options?: string[];
  createdAt: number;
  expiresAt: number;
}

export type ApprovalAnswer =
  | { decision: Decision; reason?: string }
  | { answer: string }
  | { cancelled: true; reason: string };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
};

interface Pending {
  request: ApprovalRequest;
  resolve: (a: ApprovalAnswer) => void;
  timer: unknown;
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<(open: ApprovalRequest[]) => void>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Open a request; resolves when answered, or with a denial after `timeoutMs`. */
  request(
    input: Omit<ApprovalRequest, 'createdAt' | 'expiresAt'>,
    timeoutMs: number,
  ): Promise<ApprovalAnswer> {
    const now = this.clock.now();
    const request: ApprovalRequest = { ...input, createdAt: now, expiresAt: now + timeoutMs };
    return new Promise((resolve) => {
      const timer = this.clock.setTimeout(
        () => this.settle(request.id, { cancelled: true, reason: 'No answer in time' }),
        timeoutMs,
      );
      this.pending.set(request.id, { request, resolve, timer });
      this.emit();
    });
  }

  /** Answer a request. Returns false when it was already settled (for example by the timeout). */
  answer(id: string, answer: ApprovalAnswer): boolean {
    return this.settle(id, answer);
  }

  /** Deny everything still open (agent stopped or restarted). */
  cancelAll(reason: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { cancelled: true, reason });
  }

  get open(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request;
  }

  onChange(listener: (open: ApprovalRequest[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private settle(id: string, answer: ApprovalAnswer): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.clock.clearTimeout(p.timer);
    p.resolve(answer);
    this.emit();
    return true;
  }

  private emit(): void {
    const open = this.open;
    for (const l of this.listeners) l(open);
  }
}
