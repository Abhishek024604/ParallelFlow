import {
  AI_PROVIDER_NAMES,
  AI_PROVIDERS,
  type AiKeyStatus,
  type AiProvider,
  type AiProviderList,
  isAiProvider,
} from '@parallelflow/contracts';
import type { Tx } from '@parallelflow/db';
import type { ModelKey } from '@parallelflow/runtime-client';
import { decrypt, encrypt } from '../identity/crypto.js';

// Bring your own AI key (ADR-043). A person's key (user scope, owner-only RLS) answers in their
// private chats; an arena's key (tenant scope, written by the owner only) answers for the arena's
// AI. The key is sealed here before it is stored, opened only to hand it to the runtime with a turn,
// and never logged or returned to the web: the web sees the provider, the model and the last 4.

export type Owner = { kind: 'user'; userId: string } | { kind: 'project'; projectId: string };

/** The saved key's status (never the key). */
export async function keyStatus(tx: Tx, owner: Owner, canEdit: boolean): Promise<AiKeyStatus> {
  const q = tx
    .selectFrom('ai_provider_keys')
    .select(['provider', 'model', 'key_last4', 'updated_at']);
  const row = await (
    owner.kind === 'user'
      ? q.where('user_id', '=', owner.userId)
      : q.where('project_id', '=', owner.projectId)
  ).executeTakeFirst();
  return {
    key:
      row && isAiProvider(row.provider)
        ? {
            provider: row.provider,
            model: row.model,
            last4: row.key_last4,
            updated_at: new Date(row.updated_at).toISOString(),
          }
        : null,
    can_edit: canEdit,
  };
}

/** Saves (or replaces) the owner's key, sealed. */
export async function saveKey(
  tx: Tx,
  sealKey: Buffer,
  owner: Owner & { orgId?: string },
  byUserId: string,
  input: { provider: AiProvider; model: string; apiKey: string },
): Promise<void> {
  await removeKey(tx, owner);
  await tx
    .insertInto('ai_provider_keys')
    .values({
      ...(owner.kind === 'user'
        ? { user_id: owner.userId }
        : { org_id: requireOrg(owner.orgId), project_id: owner.projectId }),
      provider: input.provider,
      model: input.model,
      secret_sealed: encrypt(sealKey, { secret: input.apiKey }),
      key_last4: input.apiKey.slice(-4),
      created_by: byUserId,
    })
    .execute();
}

function requireOrg(orgId: string | undefined): string {
  if (!orgId) throw new Error('An arena key needs its org');
  return orgId;
}

export async function removeKey(tx: Tx, owner: Owner): Promise<void> {
  const q = tx.deleteFrom('ai_provider_keys');
  await (
    owner.kind === 'user'
      ? q.where('user_id', '=', owner.userId)
      : q.where('project_id', '=', owner.projectId)
  ).execute();
}

/**
 * The key a turn answers with, opened for the runtime (RIC model_key), or null for ParallelFlow's
 * own pool. Runs in the turn's own scope: user scope for a private chat, the arena's org for an
 * arena turn, so RLS shows that owner's row only.
 */
export async function turnModelKey(
  tx: Tx,
  sealKey: Buffer,
  owner: Owner,
): Promise<ModelKey | null> {
  const q = tx.selectFrom('ai_provider_keys').select(['provider', 'model', 'secret_sealed']);
  const row = await (
    owner.kind === 'user'
      ? q.where('user_id', '=', owner.userId)
      : q.where('project_id', '=', owner.projectId)
  ).executeTakeFirst();
  if (!row) return null;
  let opened: unknown;
  try {
    opened = decrypt(sealKey, row.secret_sealed);
  } catch {
    // Sealed under another server secret: the pool answers until the key is saved again.
    return null;
  }
  const secret =
    opened &&
    typeof opened === 'object' &&
    typeof (opened as { secret?: unknown }).secret === 'string'
      ? (opened as { secret: string }).secret
      : undefined;
  return secret ? { provider: row.provider, model: row.model, api_key: secret } : null;
}

// ---------------------------------------------------------------- the providers' models

type CatalogEntry = { id: string; name?: string; type?: string };

/** Pi's bundled catalogue module of each provider (the models the runtime can call natively). */
const CATALOGUES: Record<AiProvider, () => Promise<Record<string, Record<string, CatalogEntry>>>> =
  {
    openai: () => import('@earendil-works/pi-ai/providers/openai.models'),
    anthropic: () => import('@earendil-works/pi-ai/providers/anthropic.models'),
    deepseek: () => import('@earendil-works/pi-ai/providers/deepseek.models'),
    openrouter: () => import('@earendil-works/pi-ai/providers/openrouter.models'),
    google: () => import('@earendil-works/pi-ai/providers/google.models'),
    groq: () => import('@earendil-works/pi-ai/providers/groq.models'),
    mistral: () => import('@earendil-works/pi-ai/providers/mistral.models'),
    xai: () => import('@earendil-works/pi-ai/providers/xai.models'),
    together: () => import('@earendil-works/pi-ai/providers/together.models'),
    fireworks: () => import('@earendil-works/pi-ai/providers/fireworks.models'),
  } as never;

let providerList: Promise<AiProviderList> | undefined;

/** Each provider with its chat models, from Pi's catalogue (loaded once). */
export function listProviders(): Promise<AiProviderList> {
  providerList ??= Promise.all(
    AI_PROVIDERS.map(async (id) => {
      let models: { id: string; name: string }[] = [];
      try {
        const mod = await CATALOGUES[id]();
        // The chat catalogue export (e.g. OPENAI_MODELS), keyed by model id.
        const chat = Object.entries(mod).find(
          ([name]) => /^[A-Z0-9_]+_MODELS$/.test(name) && !/_(IMAGE|CLASSIFIER)_MODELS$/.test(name),
        )?.[1];
        models = Object.values(chat ?? {})
          .filter((m) => typeof m.id === 'string' && (m.type === undefined || m.type === 'chat'))
          .map((m) => ({ id: m.id, name: m.name ?? m.id }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        // A provider whose catalogue fails to load is listed without models (type an id).
      }
      return { id, name: AI_PROVIDER_NAMES[id], models };
    }),
  ).then((items) => ({ items }));
  return providerList;
}

/** Is this one of the provider's models the runtime knows? */
export async function knowsModel(provider: AiProvider, model: string): Promise<boolean> {
  const list = await listProviders();
  return !!list.items.find((p) => p.id === provider)?.models.some((m) => m.id === model);
}

// ---------------------------------------------------------------- checking a key once

/** One cheap, read-only call per provider that only succeeds with a valid key. */
const CHECKS: Record<
  AiProvider,
  (key: string) => { url: string; headers: Record<string, string> }
> = {
  openai: (k) => bearer('https://api.openai.com/v1/models', k),
  anthropic: (k) => ({
    url: 'https://api.anthropic.com/v1/models?limit=1',
    headers: { 'x-api-key': k, 'anthropic-version': '2023-06-01' },
  }),
  deepseek: (k) => bearer('https://api.deepseek.com/models', k),
  openrouter: (k) => bearer('https://openrouter.ai/api/v1/key', k),
  google: (k) => ({
    url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
    headers: { 'x-goog-api-key': k },
  }),
  groq: (k) => bearer('https://api.groq.com/openai/v1/models', k),
  mistral: (k) => bearer('https://api.mistral.ai/v1/models', k),
  xai: (k) => bearer('https://api.x.ai/v1/models', k),
  together: (k) => bearer('https://api.together.xyz/v1/models', k),
  fireworks: (k) => bearer('https://api.fireworks.ai/inference/v1/models', k),
};

function bearer(url: string, key: string) {
  return { url, headers: { authorization: `Bearer ${key}` } };
}

export type KeyCheck = 'ok' | 'refused' | 'unreachable';

/**
 * Checks a key with the provider's own API. A rate-limited (429) or out-of-credit (402) key is a
 * valid key. Never logs the
 * key or the response.
 */
export async function checkKey(
  provider: AiProvider,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<KeyCheck> {
  const { url, headers } = CHECKS[provider](apiKey);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: AbortSignal.timeout(8000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.ok || res.status === 429 || res.status === 402) return 'ok';
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return 'refused';
    }
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}
