// Environment for the API process (doc 11 §11.7). Secrets are read here and never logged.

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  logLevel: string;
  userPerMinute: number;
  orgPerMinute: number;
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  return {
    databaseUrl,
    port: positiveInt(env, 'PORT', 4000),
    logLevel: env.LOG_LEVEL || 'info',
    userPerMinute: positiveInt(env, 'RATE_LIMIT_USER_PER_MINUTE', 600),
    orgPerMinute: positiveInt(env, 'RATE_LIMIT_ORG_PER_MINUTE', 6000),
  };
}
