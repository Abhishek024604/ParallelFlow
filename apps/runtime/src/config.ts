import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Runtime settings from the environment (doc 11 §11.7). Keys are never printed.

/** A strong general assistant on OpenRouter (id format: <vendor>/<model>, as Pi's catalogue lists it). */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-4.5';

/**
 * Tried in order after RUNTIME_MODEL when a model is overloaded, rate-limited or down (free models
 * often are). Override with RUNTIME_FALLBACK_MODELS (comma-separated; empty = no fallback).
 */
export const DEFAULT_FALLBACK_MODELS = [
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
];

export interface RuntimeConfig {
  port: number;
  jwtKey: string;
  openRouterKey: string | undefined;
  /** The primary model. */
  model: string;
  /** The primary model, then its fallbacks (no duplicates). */
  models: string[];
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
  const list = (raw: string) =>
    raw
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  const primary = list(env.RUNTIME_MODEL ?? '');
  const fallbacks =
    env.RUNTIME_FALLBACK_MODELS === undefined
      ? DEFAULT_FALLBACK_MODELS
      : list(env.RUNTIME_FALLBACK_MODELS);
  const models = [...new Set([...(primary.length ? primary : [DEFAULT_MODEL]), ...fallbacks])];
  return {
    port: port || 7070,
    jwtKey,
    openRouterKey: env.OPENROUTER_API_KEY || undefined,
    model: models[0] ?? DEFAULT_MODEL,
    models,
    dataDir: resolve(env.RUNTIME_DATA_DIR || resolve(APP_ROOT, '.data')),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
