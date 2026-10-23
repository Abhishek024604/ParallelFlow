'use client';

import type { DeviceLookup, ExtToken } from '@parallelflow/contracts';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiSend, ProblemError } from '../lib/api-browser';
import { relativeAge } from '../lib/chat';

// /device: the person types (or arrives with) the code VS Code shows, sees which app asks, and
// allows or denies it. Below, the apps connected to their account, each with Revoke.

type Step =
  | { kind: 'enter' }
  | { kind: 'confirm'; device: DeviceLookup }
  | { kind: 'done'; approved: boolean; client: string };

function message(err: unknown): string {
  return err instanceof ProblemError ? err.detail : 'Something went wrong. Please try again.';
}

function ConnectedApps({ refresh }: { refresh: number }) {
  const [items, setItems] = useState<ExtToken[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const load = useCallback(() => {
    apiGet<{ items: ExtToken[] }>('/ext/tokens')
      .then((r) => {
        setItems(r.items);
        setNow(new Date());
      })
      .catch((err: unknown) => setError(message(err)));
  }, []);
  useEffect(load, [load, refresh]);

  return (
    <section className="mt-10">
      <h2 className="label">Connected apps</h2>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      ) : items === null ? (
        <p className="mt-2 text-[13px] text-faint">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-[13px] text-faint">No apps are connected to your account.</p>
      ) : (
        <ul className="card mt-2 divide-y divide-line">
          {items.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] text-text">{t.name}</div>
                <div className="text-[12px] text-faint">
                  {now && `Connected ${relativeAge(t.created_at, now)}`}
                  {now && t.last_used_at && ` · last used ${relativeAge(t.last_used_at, now)}`}
                </div>
              </div>
              <button
                type="button"
                className="btn ghost h-8 px-3 text-[13px]"
                onClick={async () => {
                  try {
                    await apiSend('DELETE', `/ext/tokens/${t.id}`);
                    load();
                  } catch (err) {
                    setError(message(err));
                  }
                }}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DeviceApproval({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [step, setStep] = useState<Step>({ kind: 'enter' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  const lookup = useCallback(async (value: string) => {
    setBusy(true);
    setError(null);
    try {
      const device = await apiGet<DeviceLookup>(
        `/ext/device?user_code=${encodeURIComponent(value.trim())}`,
      );
      setStep({ kind: 'confirm', device });
    } catch (err) {
      setError(
        err instanceof ProblemError && err.status === 404
          ? 'This code has expired or was already used. Start sign-in again in VS Code.'
          : message(err),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (initialCode) void lookup(initialCode);
  }, [initialCode, lookup]);

  async function decide(device: DeviceLookup, decision: 'approve' | 'deny') {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/ext/device/approve', { user_code: device.user_code, decision });
      setStep({ kind: 'done', approved: decision === 'approve', client: device.client_name });
      setRefresh((n) => n + 1);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[520px] px-4 py-12">
        <h1 className="text-[22px] font-semibold text-text">Connect VS Code</h1>
        <div className="card mt-5 p-5">
          {step.kind === 'enter' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void lookup(code);
              }}
            >
              <label htmlFor="device-code" className="text-[14px] text-muted">
                Enter the code shown in VS Code
              </label>
              <input
                id="device-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCD-2345"
                autoComplete="off"
                spellCheck={false}
                maxLength={20}
                className="inp mt-2 h-11 w-full px-3 font-mono text-[18px] uppercase tracking-[0.15em]"
              />
              <button
                type="submit"
                disabled={busy || code.trim().length < 8}
                className="btn pri mt-4 h-10 w-full"
              >
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </form>
          )}
          {step.kind === 'confirm' && (
            <div>
              <p className="text-[15px] text-text">
                Allow <strong>{step.device.client_name}</strong> to use ParallelFlow as you?
              </p>
              <p className="mt-2 text-[13px] text-muted">
                It will see your arenas, open AI coding tasks and pull requests in your name, and
                use the AI on your behalf. Check that VS Code shows{' '}
                <span className="font-mono text-text">{step.device.user_code}</span>.
              </p>
              <div className="mt-5 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className="btn pri h-10 flex-1"
                  onClick={() => void decide(step.device, 'approve')}
                >
                  Allow
                </button>
                <button
                  type="button"
                  disabled={busy}
                  className="btn h-10 flex-1"
                  onClick={() => void decide(step.device, 'deny')}
                >
                  Deny
                </button>
              </div>
            </div>
          )}
          {step.kind === 'done' && (
            <p role="status" className="text-[15px] text-text">
              {step.approved
                ? `${step.client} is connected. You can go back to VS Code.`
                : `You denied ${step.client}. Nothing was connected.`}
            </p>
          )}
          {error && (
            <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
              {error}
            </p>
          )}
        </div>
        <ConnectedApps refresh={refresh} />
      </div>
    </main>
  );
}
