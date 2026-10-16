// Timing policies for the worker (F21-05).

/**
 * Relay polling (doc 05 §5.5): poll again at once after a full batch, every `minMs` while rows keep
 * coming, and double the wait up to `maxMs` while the outbox is empty or the database fails.
 */
export class IdleBackoff {
  private current: number;

  constructor(
    private readonly minMs: number,
    private readonly maxMs: number,
  ) {
    if (!(minMs > 0) || maxMs < minMs) throw new Error('IdleBackoff needs 0 < minMs <= maxMs');
    this.current = minMs;
  }

  /** The delay before the next poll, given how many rows the last poll published. */
  afterPoll(published: number, batchSize: number): number {
    if (published > 0) {
      this.current = this.minMs;
      return published >= batchSize ? 0 : this.minMs;
    }
    const delay = this.current;
    this.current = Math.min(this.maxMs, this.current * 2);
    return delay;
  }

  /** The delay after a failed poll: the longest wait, so a broken database is not hammered. */
  afterError(): number {
    this.current = this.maxMs;
    return this.maxMs;
  }
}

/**
 * pg-boss retry options for a consumer queue (doc 05 §5.11). With `retryBackoff`, pg-boss waits
 * about `retryDelay * 2^retryCount` seconds (half of it plus jitter), capped at `retryDelayMax`.
 * After `retryLimit` retries the job moves to the consumer's dead-letter queue.
 */
export interface RetryPolicy {
  retryLimit: number;
  /** Seconds. */
  retryDelay: number;
  retryBackoff: boolean;
  /** Seconds. */
  retryDelayMax: number;
}

/** 1 try + 6 retries, waits doubling from a few seconds (about 5 minutes in all), then the DLQ. */
export const DEFAULT_RETRY: RetryPolicy = {
  retryLimit: 6,
  retryDelay: 5,
  retryBackoff: true,
  retryDelayMax: 600,
};

export function retryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  const policy = { ...DEFAULT_RETRY, ...overrides };
  const { retryLimit, retryDelay, retryDelayMax } = policy;
  if (!Number.isInteger(retryLimit) || retryLimit < 0 || retryLimit > 20) {
    throw new Error('retryLimit must be an integer between 0 and 20');
  }
  if (!Number.isInteger(retryDelay) || retryDelay < 1) {
    throw new Error('retryDelay must be a positive integer (seconds)');
  }
  if (!Number.isInteger(retryDelayMax) || retryDelayMax < retryDelay) {
    throw new Error('retryDelayMax must be an integer >= retryDelay (seconds)');
  }
  return policy;
}

/**
 * The range pg-boss picks the wait from before retry number `retryCount + 1`, in seconds:
 * `retryDelay * 2^n * [0.5, 1]`, capped at `retryDelayMax` (pg-boss 12 QueueOptions.retryBackoff).
 * Without backoff the wait is always `retryDelay`.
 */
export function retryDelayRange(policy: RetryPolicy, retryCount: number): [number, number] {
  if (!policy.retryBackoff) return [policy.retryDelay, policy.retryDelay];
  const full = policy.retryDelay * 2 ** Math.min(16, retryCount);
  return [Math.min(policy.retryDelayMax, full / 2), Math.min(policy.retryDelayMax, full)];
}
