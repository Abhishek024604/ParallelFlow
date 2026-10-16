import type { Consumer } from '../consumer.js';

// Every consumer the worker runs. Each story that reacts to an event adds its consumer here
// (`defineConsumer`, doc 07 §7.5). None yet: F21-05 builds the pipe, not the business reactions.
export const CONSUMERS: readonly Consumer[] = [];
