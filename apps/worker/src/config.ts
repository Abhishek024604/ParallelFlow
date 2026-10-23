import { assertDirectUrl } from '@parallelflow/db';

// Environment for the worker process (doc 11 §11.7). Secrets are read here and never logged; error
// messages name the variable, never its value.

export interface RelaySettings {
  /** Poll interval while there is work (doc 05 §5.5: 250 ms). */
  pollMs: number;
  /** Longest wait between polls once the outbox is idle (doubles up from pollMs). */
  maxIdleMs: number;
  /** Rows claimed per transaction. */
  batchSize: number;
}

export interface WorkerConfig {
  /** App login (saras_app): consumers run their handlers here, in withSystemJob. May be pooled. */
  databaseUrl: string;
  /** Relay login (saras_relay, ADR-033): outbox relay, housekeeping and pg-boss. Direct endpoint. */
  relayDatabaseUrl: string;
  logLevel: string;
  relay: RelaySettings;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
}

function intInRange(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

const userOf = (url: string) => {
  try {
    return decodeURIComponent(new URL(url).username);
  } catch {
    return '';
  }
};

export function loadWorkerConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  const databaseUrl = required(env, 'DATABASE_URL');
  const relayDatabaseUrl = required(env, 'RELAY_DATABASE_URL');
  assertDirectUrl(relayDatabaseUrl, 'RELAY_DATABASE_URL');
  if (userOf(relayDatabaseUrl) === userOf(databaseUrl)) {
    throw new Error('RELAY_DATABASE_URL must use a different user than DATABASE_URL (ADR-033)');
  }
  const pollMs = intInRange(env, 'OUTBOX_POLL_MS', 250, 50, 60_000);
  const maxIdleMs = intInRange(env, 'OUTBOX_IDLE_MAX_MS', 2_000, pollMs, 300_000);
  return {
    databaseUrl,
    relayDatabaseUrl,
    logLevel: env.LOG_LEVEL || 'info',
    relay: { pollMs, maxIdleMs, batchSize: intInRange(env, 'OUTBOX_BATCH_SIZE', 100, 1, 1000) },
  };
}
