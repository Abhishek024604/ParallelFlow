import pg from 'pg';

// Login roles (ADR-030, ADR-033). Each environment's runtime logins are members of a NOLOGIN group
// role that a migration created: `saras_app` for the API and consumers, `saras_relay` for the outbox
// relay and pg-boss. `pnpm db:migrate` provisions them locally from the connection strings; Terraform
// does it in AWS. Never logs the URLs: they hold passwords.

interface Login {
  user: string;
  password: string;
}

function login(url: string, variable: string): Login {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!user || !password) throw new Error(`${variable} must include a user and password`);
  return { user, password };
}

const userOf = (url: string) => decodeURIComponent(new URL(url).username);

/**
 * Throws when `url` points at a pooled endpoint (Neon `-pooler` hosts, PgBouncer's usual port
 * 6432). The relay and pg-boss need a direct session: advisory locks, LISTEN and session settings
 * do not survive transaction pooling.
 */
export function assertDirectUrl(url: string, variable: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${variable} must be a postgres:// URL`);
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`${variable} must be a postgres:// URL`);
  }
  if (parsed.hostname.includes('-pooler') || parsed.port === '6432') {
    throw new Error(`${variable} must use a direct (non-pooled) endpoint`);
  }
}

/**
 * Checks that a relay login URL is usable: direct endpoint, its own user and password, and a user
 * different from the owner (MIGRATION_DATABASE_URL) and from the app login (DATABASE_URL).
 */
export function assertRelayUrl(relayUrl: string, ownerUrl: string, appUrl?: string): void {
  assertDirectUrl(relayUrl, 'RELAY_DATABASE_URL');
  const { user } = login(relayUrl, 'RELAY_DATABASE_URL');
  if (user === userOf(ownerUrl)) {
    throw new Error(
      'RELAY_DATABASE_URL must use a different user than MIGRATION_DATABASE_URL (ADR-033)',
    );
  }
  if (appUrl && user === userOf(appUrl)) {
    throw new Error('RELAY_DATABASE_URL must use a different user than DATABASE_URL (ADR-033)');
  }
}

async function ensureLogin(ownerUrl: string, member: Login, group: string): Promise<string> {
  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const ident = client.escapeIdentifier(member.user);
    const secret = client.escapeLiteral(member.password);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [member.user]);
    // New roles default to NOSUPERUSER NOBYPASSRLS. Naming those attributes explicitly needs
    // superuser on managed Postgres (Neon, RDS), so check them afterwards instead.
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    await client.query(`${verb} ROLE ${ident} LOGIN PASSWORD ${secret}`);
    await client.query(`GRANT ${client.escapeIdentifier(group)} TO ${ident}`);

    const attrs = await client.query<{ unsafe: boolean }>(
      'SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = $1',
      [member.user],
    );
    if (attrs.rows[0]?.unsafe) {
      throw new Error(`Login role ${member.user} is SUPERUSER or BYPASSRLS; RLS would not apply`);
    }
    return member.user;
  } finally {
    await client.end();
  }
}

/**
 * Creates or updates the login role named in the app connection string and makes it a member of
 * saras_app (ADR-030). Runs as the owner after migrations.
 */
export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<string> {
  const app = login(appUrl, 'DATABASE_URL');
  if (app.user === userOf(ownerUrl)) {
    throw new Error('DATABASE_URL must use a different user than MIGRATION_DATABASE_URL (ADR-030)');
  }
  return ensureLogin(ownerUrl, app, 'saras_app');
}

/**
 * Creates or updates the login role named in RELAY_DATABASE_URL and makes it a member of
 * saras_relay (ADR-033). Runs as the owner after migrations.
 */
export async function ensureRelayLogin(
  ownerUrl: string,
  relayUrl: string,
  appUrl?: string,
): Promise<string> {
  assertRelayUrl(relayUrl, ownerUrl, appUrl);
  return ensureLogin(ownerUrl, login(relayUrl, 'RELAY_DATABASE_URL'), 'saras_relay');
}
