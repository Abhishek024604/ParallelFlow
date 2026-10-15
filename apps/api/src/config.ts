// Environment for the API process (doc 11 §11.7). Secrets are read here and never logged; error
// messages name the variable, never its value.

export interface WorkosConfig {
  apiKey: string;
  clientId: string;
  /** Encrypts the WorkOS sealed session; HKDF input for our cookie keys. At least 32 characters. */
  cookiePassword: string;
  redirectUri: string;
}

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  logLevel: string;
  userPerMinute: number;
  orgPerMinute: number;
  /** The web app: CORS origin and the only allowed post-login redirect target. */
  webOrigin: string;
  /** Domain attribute for the readable `saras_csrf` cookie when web and API are sibling hosts. */
  cookieDomain?: string;
  /** Secure cookies. Off only when the API itself is served from http://localhost. */
  secureCookies: boolean;
  /** Unset = login is off and every authenticated route answers 401 (no backdoor). */
  workos?: WorkosConfig;
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

export function loadConfig(env: NodeJS.ProcessEnv): ApiConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  const auth = workos(env);
  const domain = cookieDomain(env);
  return {
    databaseUrl,
    port: positiveInt(env, 'PORT', 4000),
    logLevel: env.LOG_LEVEL || 'info',
    userPerMinute: positiveInt(env, 'RATE_LIMIT_USER_PER_MINUTE', 600),
    orgPerMinute: positiveInt(env, 'RATE_LIMIT_ORG_PER_MINUTE', 6000),
    webOrigin: webOrigin(env),
    ...(domain && { cookieDomain: domain }),
    // The cookies belong to the API's host, which the redirect URI names.
    secureCookies: auth ? new URL(auth.redirectUri).protocol === 'https:' : true,
    ...(auth && { workos: auth }),
  };
}
