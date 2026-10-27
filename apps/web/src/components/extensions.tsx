'use client';

import type { ExtensionList } from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { apiSend, ProblemError } from '../lib/api-browser';
import { CheckIcon, PuzzleIcon } from './icons';

// Extensions marketplace (Private, ADR-039). An extension gives your private AI a specialist
// workflow and its command (/pm, /swa) in all of your private chats. Until you install one, the AI
// works as a general assistant. Arenas never use extensions. Connected services (Linear for the
// Product Manager) are yours only; the key is checked once and never shown again.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

type Item = ExtensionList['extensions'][number];

export function Extensions({ initial }: { initial: ExtensionList }) {
  const router = useRouter();
  const [list, setList] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);

  const run = async (key: string, method: 'PUT' | 'DELETE', path: string, body?: unknown) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    try {
      setList(await apiSend<ExtensionList>(method, path, body));
      router.refresh();
    } catch (err) {
      setError({ key, text: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const linear = list.connections.find((c) => c.provider === 'linear');

  return (
    <div className="mx-auto max-w-[900px] px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[22px] font-bold text-text">Extensions</h1>
        <span className="text-[13px] text-faint">For your private chats only</span>
      </div>
      <p className="mt-2 max-w-[640px] text-[15px] text-muted">
        Give your AI a specialist workflow. Once installed, its command works in all of your private
        chats. Without one, your AI is a general assistant.
      </p>

      <ul className="mt-6 grid gap-4 sm:grid-cols-2">
        {list.extensions.map((e) => (
          <li key={e.key} className="card flex flex-col p-4">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 text-muted">
                <PuzzleIcon size={20} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[16px] font-semibold text-text">{e.name}</h2>
                  {e.soon && <span className="chip px-1.5 py-0.5 text-[12px]">Soon</span>}
                  {e.installed && (
                    <span className="chip ok gap-1 px-1.5 py-0.5 text-[12px]">
                      <CheckIcon size={12} />
                      Installed
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[14px] text-muted">{e.tagline}</p>
              </div>
            </div>
            <p className="mt-3 flex-1 text-[14px] text-text">{e.description}</p>
            {e.command && (
              <p className="mt-2 text-[13px] text-faint">
                In a chat, type <code className="font-mono text-text">/{e.command}</code>
              </p>
            )}

            {e.installed && e.connections?.includes('linear') && (
              <LinearConnection
                connected={linear?.label ?? null}
                busy={busy === 'linear'}
                error={error?.key === 'linear' ? error.text : null}
                onConnect={(apiKey) =>
                  void run('linear', 'PUT', '/private/connections/linear', { api_key: apiKey })
                }
                onDisconnect={() => void run('linear', 'DELETE', '/private/connections/linear')}
              />
            )}

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <InstallButton
                item={e}
                busy={busy === e.key}
                onInstall={() => void run(e.key, 'PUT', `/private/extensions/${e.key}`)}
                onRemove={() => void run(e.key, 'DELETE', `/private/extensions/${e.key}`)}
              />
              {error?.key === e.key && (
                <p role="alert" className="text-[13px] text-bad">
                  {error.text}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function InstallButton({
  item,
  busy,
  onInstall,
  onRemove,
}: {
  item: Item;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  if (item.soon) {
    return (
      <button type="button" className="btn h-9 px-3" disabled>
        Coming soon
      </button>
    );
  }
  if (item.installed) {
    return (
      <button type="button" className="btn ghost h-9 px-3" disabled={busy} onClick={onRemove}>
        {busy ? 'Removing…' : 'Uninstall'}
      </button>
    );
  }
  return (
    <button type="button" className="btn pri h-9 px-4" disabled={busy} onClick={onInstall}>
      {busy ? 'Installing…' : 'Install'}
    </button>
  );
}

function LinearConnection({
  connected,
  busy,
  error,
  onConnect,
  onDisconnect,
}: {
  connected: string | null;
  busy: boolean;
  error: string | null;
  onConnect: (apiKey: string) => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (apiKey.trim()) onConnect(apiKey.trim());
  };

  if (connected) {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-line px-3 py-2">
        <span className="chip ok px-1.5 py-0.5 text-[12px]">Linear</span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{connected}</span>
        <button
          type="button"
          className="btn ghost h-8 px-2 text-[13px]"
          disabled={busy}
          onClick={onDisconnect}
        >
          {busy ? 'Disconnecting…' : 'Disconnect'}
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <div className="mt-3 rounded-md border border-line px-3 py-2">
        <p className="text-[13px] text-muted">
          Optional: connect Linear so your AI can read issues and, after you confirm, create or
          update them.
        </p>
        <button
          type="button"
          className="btn mt-2 h-8 px-3 text-[13px]"
          onClick={() => setOpen(true)}
        >
          Connect Linear
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="mt-3 space-y-2 rounded-md border border-line px-3 py-2">
      <label className="block">
        <span className="text-[13px] text-muted">Linear API key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          autoComplete="off"
          placeholder="lin_api_…"
          autoFocus
          className="inp mt-1 h-9 w-full px-2.5 font-mono text-[13px]"
        />
      </label>
      <p className="text-[12px] text-faint">
        Create one in Linear under Settings › Security &amp; access › Personal API keys. Only your
        AI uses it, in your private chats.
      </p>
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          className="btn pri h-8 px-3 text-[13px]"
          disabled={busy || !apiKey.trim()}
        >
          {busy ? 'Checking…' : 'Connect'}
        </button>
        <button
          type="button"
          className="btn ghost h-8 px-2 text-[13px]"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
