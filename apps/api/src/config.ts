// Environment for the API process (doc 11 §11.7). Secrets are read here and never logged; error
// messages name the variable, never its value.

import { createPrivateKey } from 'node:crypto';
import type { GithubAppConfig } from './github/github-app.js';
import { allowedModels, type ModelTier, tierOf } from './llm/models.js';

export interface WorkosConfig {
  apiKey: string;
  clientId: string;
  /** Encrypts the WorkOS sealed session; HKDF input for our cookie keys. At least 32 characters. */
  cookiePassword: string;
  redirectUri: string;
}

/** The agent runtime (RIC v0.2). Unset `url` = AI is not connected: @AI turns fail fast. */
export interface RuntimeConfig {
  /** RUNTIME_URL: base URL including the version path, e.g. http://localhost:7070/v1. */
  url?: string;
  /** RUNTIME_JWT_KEY: signs the service JWT on every runtime call (HS256). */
  jwtKey?: string;
  /** TOOL_TOKEN_KEY: signs session-scoped App Tools tokens (HS256). */
  toolTokenKey?: string;
  /** APP_TOOLS_URL: the App Tools MCP endpoint handed to the runtime. */
  appToolsUrl: string;
}

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  logLevel: string;
  userPerMinute: number;
  orgPerMinute: number;
  /** The web app: CORS origin and the only allowed post-login redirect target. */
  webOrigin: string;
  /** Domain attribute for the readable `parallelflow_csrf` cookie when web and API are sibling hosts. */
  cookieDomain?: string;
  /** Secure cookies. Off only when the redirect URI (the cookies' host) is http://localhost. */
  secureCookies: boolean;
  /** Unset = login is off and every authenticated route answers 401 (no backdoor). */
  workos?: WorkosConfig;
  runtime: RuntimeConfig;
  /** The extension's LLM proxy (ADR-037). */
  llm: { apiKey?: string; models: string[]; tiers: Record<string, ModelTier>; perMinute: number };
  /** The ParallelFlow GitHub App (ADR-040). Unset = arenas cannot connect to GitHub. */
  github?: GithubAppConfig;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const COOKIE_PASSWORD_MIN = 32;

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** An http(s) URL; plain http only for localhost. */
function webUrl(name: string, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${name} must use https (http is allowed for localhost only)`);
  }
  return url;
}

function webOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.WEB_ORIGIN || 'http://localhost:3000';
  const url = webUrl('WEB_ORIGIN', raw);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) {
    throw new Error('WEB_ORIGIN must be an origin like https://app.example.com (no path)');
  }
  return url.origin;
}

function cookieDomain(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.COOKIE_DOMAIN;
  if (!raw) return undefined;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(raw)) {
    throw new Error('COOKIE_DOMAIN must be a domain name like example.com');
  }
  return raw.toLowerCase();
}

function workos(env: NodeJS.ProcessEnv): WorkosConfig | undefined {
  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;
  const redirectUri = env.WORKOS_REDIRECT_URI;
  // The redirect URI alone has a local default in .env.example; it does not turn login on.
  if (!apiKey && !clientId && !cookiePassword) return undefined;
  const missing = Object.entries({
    WORKOS_API_KEY: apiKey,
    WORKOS_CLIENT_ID: clientId,
    WORKOS_COOKIE_PASSWORD: cookiePassword,
    WORKOS_REDIRECT_URI: redirectUri,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length || !apiKey || !clientId || !cookiePassword || !redirectUri) {
    throw new Error(
      `WorkOS is partly configured; also set ${missing.join(', ')} (see .env.example)`,
    );
  }
  if (cookiePassword.length < COOKIE_PASSWORD_MIN) {
    throw new Error(`WORKOS_COOKIE_PASSWORD must be at least ${COOKIE_PASSWORD_MIN} characters`);
  }
  webUrl('WORKOS_REDIRECT_URI', redirectUri);
  return { apiKey, clientId, cookiePassword, redirectUri };
}

const SIGNING_KEY_MIN = 32;

function httpUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be an http(s) URL`);
  }
  return raw.replace(/\/+$/, '');
}

function runtime(env: NodeJS.ProcessEnv): RuntimeConfig {
  const appToolsUrl = httpUrl('APP_TOOLS_URL', env.APP_TOOLS_URL || 'http://localhost:4200/mcp');
  const keys = { RUNTIME_JWT_KEY: env.RUNTIME_JWT_KEY, TOOL_TOKEN_KEY: env.TOOL_TOKEN_KEY };
  for (const [name, value] of Object.entries(keys)) {
    if (value && value.length < SIGNING_KEY_MIN) {
      throw new Error(`${name} must be at least ${SIGNING_KEY_MIN} characters`);
    }
  }
  if (!env.RUNTIME_URL) {
    return {
      appToolsUrl,
      ...(keys.RUNTIME_JWT_KEY && { jwtKey: keys.RUNTIME_JWT_KEY }),
      ...(keys.TOOL_TOKEN_KEY && { toolTokenKey: keys.TOOL_TOKEN_KEY }),
    };
  }
  const missing = Object.entries(keys)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length || !keys.RUNTIME_JWT_KEY || !keys.TOOL_TOKEN_KEY) {
    throw new Error(`RUNTIME_URL is set; also set ${missing.join(', ')} (see .env.example)`);
  }
  return {
    url: httpUrl('RUNTIME_URL', env.RUNTIME_URL),
    jwtKey: keys.RUNTIME_JWT_KEY,
    toolTokenKey: keys.TOOL_TOKEN_KEY,
    appToolsUrl,
  };
}

const GITHUB_VARS = [
  'GITHUB_APP_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
] as const;

/** All of GITHUB_VARS, or none (GitHub off). The private key may have its newlines as \n. */
function github(env: NodeJS.ProcessEnv): GithubAppConfig | undefined {
  const set = GITHUB_VARS.filter((name) => env[name]);
  if (set.length === 0) return undefined;
  const missing = GITHUB_VARS.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(
      `GitHub is partly configured; also set ${missing.join(', ')} (see .env.example)`,
    );
  }
  const value = (name: (typeof GITHUB_VARS)[number]) => env[name] ?? '';
  if (!/^\d{1,12}$/.test(value('GITHUB_APP_ID'))) {
    throw new Error('GITHUB_APP_ID must be the numeric App ID');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/i.test(value('GITHUB_APP_SLUG'))) {
    throw new Error('GITHUB_APP_SLUG must be the app name in its URL (github.com/apps/<slug>)');
  }
  if (value('GITHUB_WEBHOOK_SECRET').length < 20) {
    throw new Error('GITHUB_WEBHOOK_SECRET must be at least 20 characters');
  }
  const privateKey = value('GITHUB_APP_PRIVATE_KEY').replace(/\n/g, '\n');
  try {
    createPrivateKey(privateKey);
  } catch {
    throw new Error('GITHUB_APP_PRIVATE_KEY must be the app private key (PEM)');
  }
  return {
    appId: value('GITHUB_APP_ID'),
    slug: value('GITHUB_APP_SLUG'),
    privateKey,
    webhookSecret: value('GITHUB_WEBHOOK_SECRET'),
    clientId: value('GITHUB_APP_CLIENT_ID'),
    clientSecret: value('GITHUB_APP_CLIENT_SECRET'),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const auth = workos(env);
  const domain = cookieDomain(env);
  const gh = github(env);
  return {
    databaseUrl,
    port: positiveInt(env, 'PORT', 4000),
    logLevel: env.LOG_LEVEL || 'info',
    userPerMinute: positiveInt(env, 'RATE_LIMIT_USER_PER_MINUTE', 600),
    orgPerMinute: positiveInt(env, 'RATE_LIMIT_ORG_PER_MINUTE', 6000),
    webOrigin: webOrigin(env),
    ...(domain && { cookieDomain: domain }),
    // The cookies belong to the host the redirect URI names: the web origin, which proxies /v1.
    secureCookies: auth ? new URL(auth.redirectUri).protocol === 'https:' : true,
    ...(auth && { workos: auth }),
    runtime: runtime(env),
    llm: {
      ...(env.OPENROUTER_API_KEY && { apiKey: env.OPENROUTER_API_KEY }),
      models: allowedModels(env),
      tiers: tierOf(env),
      perMinute: positiveInt(env, 'RATE_LIMIT_LLM_PER_MINUTE', 60),
    },
    ...(gh && { github: gh }),
  };
}
