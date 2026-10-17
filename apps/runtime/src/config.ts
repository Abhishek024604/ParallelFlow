import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime settings from the environment (doc 11 §11.7). Keys are never printed.

/** A strong general assistant on OpenRouter (id format: <vendor>/<model>, as Pi's catalogue lists it). */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

export interface RuntimeConfig {
  port: number;
  jwtKey: string;
  openRouterKey: string | undefined;
  model: string;
  dataDir: string;
  logLevel: string;
}

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

export function loadConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const jwtKey = env.RUNTIME_JWT_KEY ?? '';
  if (jwtKey.length < 32) {
    throw new Error('RUNTIME_JWT_KEY must be set (at least 32 characters, same as the API)');
  }
  let port = Number(env.RUNTIME_PORT || 0);
  if (!port && env.RUNTIME_URL) {
    try {
      port = Number(new URL(env.RUNTIME_URL).port);
    } catch {
      throw new Error('RUNTIME_URL must be an absolute URL');
    }
  }
  return {
    port: port || 7070,
    jwtKey,
    openRouterKey: env.OPENROUTER_API_KEY || undefined,
    model: env.RUNTIME_MODEL || DEFAULT_MODEL,
    dataDir: resolve(env.RUNTIME_DATA_DIR || resolve(APP_ROOT, '.data')),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
