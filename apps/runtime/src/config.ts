import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectorNames } from './connectors.js';

// Runtime settings from the environment (doc 11 §11.7). Keys are never printed.
//
// Models (OpenRouter ids, <vendor>/<model> as Pi's catalogue lists them) come from the environment
// only: there are no built-in models. Sessions run on the `parallelflow/auto` virtual model
// (packages/pi-parallelflow router), which picks per request:
//   RUNTIME_MODEL set      → that one model for everything (forced), then the fallbacks
//   otherwise              → RUNTIME_MODEL_FAST for quick replies, RUNTIME_MODEL_STRONG for
//                            documents, code, summaries and tool-heavy turns (a tier left unset
//                            uses the other), then RUNTIME_FALLBACK_MODELS, in order, on overload
//                            or rate limit (unset = no fallback).
// No model set: sessions work and every AI turn fails fast saying so.

export interface ModelConfig {
  /** Quick replies, in order. */
  fast: string[];
  /** Documents, code, summaries, tool-heavy turns, in order. */
  strong: string[];
  /** After both tiers, in order. */
  fallbacks: string[];
  /** RUNTIME_MODEL was set: fast and strong are that one model. */
  forced: boolean;
}

export interface RuntimeConfig {
  port: number;
  jwtKey: string;
  openRouterKey: string | undefined;
  /** The strong model (usage reports' default). */
  model: string;
  /** Every model a session may use, no duplicates (capabilities, catalogue check). */
  models: string[];
  routing: ModelConfig;
  /** Enabled connectors (RUNTIME_CONNECTORS, comma-separated; default drawio, empty = none). */
  connectors: string[];
  dataDir: string;
  logLevel: string;
}

const APP_ROOT = fileURLToPath(new URL('..', import.meta.url));

const list = (raw: string) =>
  raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);

/** Model routing from the environment (see the header for precedence). */
export function modelConfig(env: NodeJS.ProcessEnv): ModelConfig {
  const forced = list(env.RUNTIME_MODEL ?? '');
  const fallbacks = list(env.RUNTIME_FALLBACK_MODELS ?? '');
  if (forced.length) return { fast: forced, strong: forced, fallbacks, forced: true };
  const fast = list(env.RUNTIME_MODEL_FAST ?? '');
  const strong = list(env.RUNTIME_MODEL_STRONG ?? '');
  return {
    fast: fast.length ? fast : strong,
    strong: strong.length ? strong : fast,
    fallbacks,
    forced: false,
  };
}

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
  const routing = modelConfig(env);
  const models = [...new Set([...routing.strong, ...routing.fast, ...routing.fallbacks])];
  return {
    port: port || 7070,
    jwtKey,
    openRouterKey: env.OPENROUTER_API_KEY || undefined,
    model: routing.strong[0] ?? routing.fallbacks[0] ?? '',
    models,
    routing,
    connectors: connectorNames(env.RUNTIME_CONNECTORS),
    dataDir: resolve(env.RUNTIME_DATA_DIR || resolve(APP_ROOT, '.data')),
    logLevel: env.LOG_LEVEL || 'info',
  };
}
