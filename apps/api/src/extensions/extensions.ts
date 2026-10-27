import {
  type ConnectionProvider,
  EXTENSIONS,
  type ExtensionKey,
  type ExtensionList,
  isExtensionKey,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { TurnExtensions } from '@parallelflow/runtime-client';
import { decrypt, encrypt } from '../identity/crypto.js';

// Private extensions and connected services (ADR-039). Every query runs in the caller's user scope
// (db.withUser), so owner-only RLS shows a person their own rows only. A connected service's
// credential is sealed here before it is stored and opened only to hand it to the runtime with a
// private turn; it is never logged or returned to the web.

export async function installedKeys(tx: Tx, userId: string): Promise<ExtensionKey[]> {
  const rows = await tx
    .selectFrom('user_extensions')
    .select('extension_key')
    .where('user_id', '=', userId)
    .orderBy('installed_at')
    .execute();
  return rows.map((r) => r.extension_key).filter(isExtensionKey);
}

export async function listExtensions(tx: Tx, userId: string): Promise<ExtensionList> {
  const installed = new Set<string>(await installedKeys(tx, userId));
  const connections = await tx
    .selectFrom('user_connections')
    .select(['provider', 'label', 'created_at'])
    .where('user_id', '=', userId)
    .execute();
  return {
    extensions: EXTENSIONS.map((e) => ({ ...e, installed: installed.has(e.key) })),
    connections: connections.map((c) => ({
      provider: c.provider as ConnectionProvider,
      label: c.label,
      connected_at: new Date(c.created_at).toISOString(),
    })),
  };
}

export async function install(tx: Tx, userId: string, key: ExtensionKey): Promise<void> {
  await tx
    .insertInto('user_extensions')
    .values({ user_id: userId, extension_key: key })
    .onConflict((oc) => oc.columns(['user_id', 'extension_key']).doNothing())
    .execute();
}

/** Uninstalling keeps the extension's documents: they stay ordinary files of their chats. */
export async function uninstall(tx: Tx, userId: string, key: ExtensionKey): Promise<void> {
  await tx
    .deleteFrom('user_extensions')
    .where('user_id', '=', userId)
    .where('extension_key', '=', key)
    .execute();
}

export async function saveConnection(
  tx: Tx,
  key: Buffer,
  userId: string,
  connection: { provider: ConnectionProvider; secret: string; label: string },
): Promise<void> {
  const sealed = encrypt(key, { secret: connection.secret });
  await tx
    .insertInto('user_connections')
    .values({
      user_id: userId,
      provider: connection.provider,
      secret_sealed: sealed,
      label: connection.label,
    })
    .onConflict((oc) =>
      oc.columns(['user_id', 'provider']).doUpdateSet({
        secret_sealed: sealed,
        label: connection.label,
        created_at: new Date(),
      }),
    )
    .execute();
}

export async function removeConnection(
  tx: Tx,
  userId: string,
  provider: ConnectionProvider,
): Promise<void> {
  await tx
    .deleteFrom('user_connections')
    .where('user_id', '=', userId)
    .where('provider', '=', provider)
    .execute();
}

/** What a private turn tells the runtime: installed extensions and, for PM, the Linear key. */
export async function turnExtensions(tx: Tx, key: Buffer, userId: string): Promise<TurnExtensions> {
  const installed = await installedKeys(tx, userId);
  if (!installed.includes('pm')) return { installed };
  const linear = await tx
    .selectFrom('user_connections')
    .select('secret_sealed')
    .where('user_id', '=', userId)
    .where('provider', '=', 'linear')
    .executeTakeFirst();
  const opened = linear ? decrypt(key, linear.secret_sealed) : undefined;
  const secret =
    opened &&
    typeof opened === 'object' &&
    typeof (opened as { secret?: unknown }).secret === 'string'
      ? (opened as { secret: string }).secret
      : undefined;
  return { installed, ...(secret && { linear: { token: secret } }) };
}

const LINEAR_GRAPHQL = 'https://api.linear.app/graphql';

/**
 * Checks a Linear API key once, with Linear's own API: the workspace and person it belongs to
 * ("Acme · Dana"), or null when Linear refuses it or cannot be reached.
 */
export async function linearLabel(
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(LINEAR_GRAPHQL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query: '{ viewer { name } organization { name } }' }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { viewer?: { name?: string }; organization?: { name?: string } };
    };
    const person = body.data?.viewer?.name;
    if (!person) return null;
    const org = body.data?.organization?.name;
    return (org ? `${org} · ${person}` : person).slice(0, 120);
  } catch {
    return null;
  }
}
