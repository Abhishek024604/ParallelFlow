import pg from 'pg';

/**
 * Creates or updates the login role named in the app connection string and makes it a member of
 * saras_app (ADR-030). Runs as the owner after migrations. Never logs the URLs: they hold passwords.
 */
export async function ensureAppLogin(ownerUrl: string, appUrl: string): Promise<string> {
  const owner = new URL(ownerUrl);
  const app = new URL(appUrl);
  const user = decodeURIComponent(app.username);
  const password = decodeURIComponent(app.password);

  if (!user || !password) {
    throw new Error('DATABASE_URL must include the app login user and password');
  }
  if (user === decodeURIComponent(owner.username)) {
    throw new Error('DATABASE_URL must use a different user than MIGRATION_DATABASE_URL (ADR-030)');
  }

  const client = new pg.Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    const ident = client.escapeIdentifier(user);
    const secret = client.escapeLiteral(password);
    const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
    // New roles default to NOSUPERUSER NOBYPASSRLS. Naming those attributes explicitly needs
    // superuser on managed Postgres (Neon, RDS), so check them afterwards instead.
    const verb = exists.rowCount ? 'ALTER' : 'CREATE';
    await client.query(`${verb} ROLE ${ident} LOGIN PASSWORD ${secret}`);
    await client.query(`GRANT saras_app TO ${ident}`);

    const attrs = await client.query<{ unsafe: boolean }>(
      'SELECT rolsuper OR rolbypassrls AS unsafe FROM pg_roles WHERE rolname = $1',
      [user],
    );
    if (attrs.rows[0]?.unsafe) {
      throw new Error(`App login role ${user} is SUPERUSER or BYPASSRLS; RLS would not apply`);
    }
    return user;
  } finally {
    await client.end();
  }
}
