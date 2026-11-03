'use client';

import type { AiKeyStatus, AiProvider, AiProviderList } from '@parallelflow/contracts';
import { type FormEvent, useState } from 'react';
import { apiSend, ProblemError } from '../lib/api-browser';

// "AI provider" (ADR-043): bring your own AI key. Used in Settings (your key, for your private chats)
// and in arena settings (the arena owner's key, for the arena's AI; members see the status only).
// The key is checked with the provider once and never shown again: only its last 4.

const OTHER = '__other__';

const message = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Try again.';

export function AiKeyCard({
  title,
  description,
  path,
  initial,
  providers,
}: {
  title: string;
  description: string;
  /** API path of the key: /me/ai-key or /projects/{id}/ai-key. */
  path: string;
  initial: AiKeyStatus;
  providers: AiProviderList;
}) {
  const [status, setStatus] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saved = status.key;
  const nameOf = (id: string) => providers.items.find((p) => p.id === id)?.name ?? id;

  const send = async (method: 'PUT' | 'DELETE', body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await apiSend<AiKeyStatus>(method, path, body));
      setEditing(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card mt-4 px-5 py-4">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-text">{title}</div>
          <div className="text-[14px] text-muted">{description}</div>
          <div className="mt-2 text-[14px] text-text">
            {saved ? (
              <>
                {nameOf(saved.provider)} · <span className="font-mono">{saved.model}</span> ·{' '}
                <span className="font-mono">•••• {saved.last4}</span>
              </>
            ) : (
              <span className="text-faint">
                Without your own key, ParallelFlow&apos;s AI is used.
              </span>
            )}
          </div>
        </div>
        {status.can_edit && !editing && (
          <div className="flex gap-2">
            {saved && (
              <button
                type="button"
                className="btn ghost h-9 px-3"
                disabled={busy}
                onClick={() => void send('DELETE')}
              >
                {busy ? 'Removing…' : 'Remove'}
              </button>
            )}
            <button type="button" className="btn h-9 px-4" onClick={() => setEditing(true)}>
              {saved ? 'Change' : 'Add key'}
            </button>
          </div>
        )}
      </div>
      {editing && (
        <KeyForm
          providers={providers}
          initialProvider={saved?.provider}
          initialModel={saved?.model}
          busy={busy}
          onCancel={() => {
            setEditing(false);
            setError(null);
          }}
          onSave={(body) => void send('PUT', body)}
        />
      )}
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      )}
      {!status.can_edit && (
        <p className="mt-2 text-[12px] text-faint">Only the arena owner can change this.</p>
      )}
    </div>
  );
}

function KeyForm({
  providers,
  initialProvider,
  initialModel,
  busy,
  onCancel,
  onSave,
}: {
  providers: AiProviderList;
  initialProvider: AiProvider | undefined;
  initialModel: string | undefined;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: { provider: AiProvider; api_key: string; model: string }) => void;
}) {
  const first = providers.items[0]?.id ?? 'openai';
  const [provider, setProvider] = useState<AiProvider>(initialProvider ?? first);
  const models = providers.items.find((p) => p.id === provider)?.models ?? [];
  const known = (id: string | undefined) => !!id && models.some((m) => m.id === id);
  const [model, setModel] = useState(
    known(initialModel) ? (initialModel as string) : (models[0]?.id ?? OTHER),
  );
  const [custom, setCustom] = useState(known(initialModel) ? '' : (initialModel ?? ''));
  const [apiKey, setApiKey] = useState('');
  const chosen = model === OTHER ? custom.trim() : model;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim() && chosen) onSave({ provider, api_key: apiKey.trim(), model: chosen });
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-3 border-t border-line pt-4">
      <label className="block">
        <span className="text-[13px] text-muted">Provider</span>
        <select
          value={provider}
          onChange={(e) => {
            const next = e.target.value as AiProvider;
            setProvider(next);
            setModel(providers.items.find((p) => p.id === next)?.models[0]?.id ?? OTHER);
          }}
          className="inp mt-1 h-9 w-full px-2 text-[14px]"
        >
          {providers.items.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-[13px] text-muted">API key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          placeholder="Paste your key"
          className="inp mt-1 h-9 w-full px-2.5 font-mono text-[13px]"
        />
      </label>
      <label className="block">
        <span className="text-[13px] text-muted">Model</span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="inp mt-1 h-9 w-full px-2 font-mono text-[13px]"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name === m.id ? m.id : `${m.name} (${m.id})`}
            </option>
          ))}
          <option value={OTHER}>Other model id…</option>
        </select>
      </label>
      {model === OTHER && (
        <label className="block">
          <span className="text-[13px] text-muted">Model id</span>
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            autoComplete="off"
            placeholder="e.g. gpt-4.1"
            className="inp mt-1 h-9 w-full px-2.5 font-mono text-[13px]"
          />
        </label>
      )}
      <p className="text-[12px] text-faint">
        We check the key with the provider once, then keep it encrypted. If it stops working, the AI
        quietly uses ParallelFlow&apos;s AI instead.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn pri h-9 px-4"
          disabled={busy || !apiKey.trim() || !chosen}
        >
          {busy ? 'Checking…' : 'Test and save'}
        </button>
        <button type="button" className="btn ghost h-9 px-3" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
