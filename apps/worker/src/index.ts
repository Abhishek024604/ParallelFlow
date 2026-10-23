// Outbox relay, pg-boss consumers and housekeeping crons (doc 05 §5.9, F21-05).
export const workspace = '@parallelflow/worker' as const;

export { DEFAULT_RETRY, IdleBackoff, retryDelayRange, retryPolicy } from './backoff.js';
export type { RetryPolicy } from './backoff.js';
export { loadWorkerConfig } from './config.js';
export type { RelaySettings, WorkerConfig } from './config.js';
export {
  ConsumerFailedError,
  consumerQueue,
  deadLetterQueue,
  defineConsumer,
  runConsumerJob,
} from './consumer.js';
export type { Consumer, ConsumerContext, ConsumerJob, RunOutcome } from './consumer.js';
export { CONSUMERS } from './consumers/index.js';
export { HOUSEKEEPING } from './housekeeping.js';
export type { HousekeepingTask } from './housekeeping.js';
export { OutboxRelay, routeTable } from './relay.js';
export type { JobSender } from './relay.js';
export { startWorker } from './worker.js';
export type { RunningWorker, WorkerOptions } from './worker.js';
