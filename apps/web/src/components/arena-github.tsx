'use client';

import {
  GITHUB_ERROR_PARAM,
  GITHUB_GRANT_PARAM,
  type GithubConnectError,
  type GithubConnectStart,
  type GithubRepoChoice,
  type GithubStatus,
} from '@parallelflow/contracts';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiSend, ProblemError } from '../lib/api-browser';
import { relativeAge } from '../lib/chat';

// GitHub in the arena's Repository section (ADR-040): the connected repository, when it last
// synced (or why it could not), and for the arena owner Connect, Sync now and Disconnect. Connect
// goes to GitHub to install the ParallelFlow app; GitHub sends the owner back here with a grant of
// the repositories they picked, and they choose one.

const POLL_MS = 10_000;

const CONNECT_ERRORS: Record<GithubConnectError, string> = {
  denied: 'GitHub was not connected. Nothing changed.',
  expired: 'That took too long. Press Connect GitHub to try again.',
  no_access:
    'Your GitHub account cannot use that installation. Ask its owner, or pick your own account.',
  no_repos: 'No repository was picked on GitHub. Press Connect GitHub and pick one.',
  failed: 'GitHub could not be reached. Try again in a moment.',
};

function message(err: unknown): string {
  return err instanceof ProblemError ? err.detail : 'Something went wrong. Please try again.';
}

function RepoPicker({
  projectId,
  grant,
  onDone,
}: {
  projectId: string;
  grant: string;
  onDone: (status: GithubStatus | null) => void;
}) {
  const [choices, setChoices] = useState<GithubRepoChoice[] | null>(null);
  const [picked, setPicked] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    apiGet<{ items: GithubRepoChoice[] }>(
      `/projects/${projectId}/github/choices?grant=${encodeURIComponent(grant)}`,
      abort.signal,
    )
      .then(({ items }) => {
        setChoices(items);
        if (items.length === 1) setPicked(items[0]?.id ?? null);
      })
      .catch((err: unknown) => !abort.signal.aborted && setError(message(err)));
    return () => abort.abort();
  }, [projectId, grant]);

  async function connect() {
    if (picked === null) return;
    setBusy(true);
    setError(null);
    try {
      onDone(
        await apiPost<GithubStatus>(`/projects/${projectId}/github/repo`, {
          grant,
          repo_id: picked,
        }),
      );
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  return (
    <div className="card space-y-3 p-3">
      <p className="text-[13px] text-text">Pick the repository for this arena.</p>
      {choices === null && !error && <p className="text-[13px] text-faint">Loading…</p>}
      {choices?.length === 0 && (
        <p className="text-[13px] text-faint">
          The ParallelFlow app cannot see any of the repositories you picked.
        </p>
      )}
      {choices && choices.length > 0 && (
        <fieldset className="space-y-1">
          <legend className="sr-only">Repository</legend>
          {choices.map((choice) => (
            <label key={choice.id} className="flex items-center gap-2 text-[13px] text-text">
              <input
                type="radio"
                name="github-repo"
                checked={picked === choice.id}
                onChange={() => setPicked(choice.id)}
              />
              <span className="min-w-0 flex-1 truncate font-mono">{choice.full_name}</span>
              {choice.private && <span className="text-[12px] text-faint">private</span>}
            </label>
          ))}
        </fieldset>
      )}
      <p className="text-[12px] text-faint">
        GitHub becomes this arena&apos;s repository. Each approved stage is pushed to its default
        branch, and changes made on GitHub show here.
      </p>
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="btn pri h-8 px-3 text-[13px]"
          disabled={picked === null || busy}
          onClick={() => void connect()}
        >
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <button
          type="button"
          className="btn ghost h-8 px-2 text-[13px]"
          disabled={busy}
          onClick={() => onDone(null)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function ArenaGithub({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const grant = params.get(GITHUB_GRANT_PARAM);
  const returned = params.get(GITHUB_ERROR_PARAM) as GithubConnectError | null;

  const load = useCallback(
    () =>
      apiGet<GithubStatus>(`/projects/${projectId}/github`)
        .then((next) => {
          setStatus(next);
          setNow(new Date());
        })
        .catch(() => undefined),
    [projectId],
  );

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (returned) setError(CONNECT_ERRORS[returned] ?? CONNECT_ERRORS.failed);
  }, [returned]);

  /** Drops GitHub's return parameters from the address bar. */
  const clearParams = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.delete(GITHUB_GRANT_PARAM);
    next.delete(GITHUB_ERROR_PARAM);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  const connect = () =>
    act(async () => {
      const { url } = await apiPost<GithubConnectStart>(`/projects/${projectId}/github/connect`);
      window.location.assign(url);
    });
  const sync = () =>
    act(async () => {
      await apiPost<undefined>(`/projects/${projectId}/github/sync`);
      setTimeout(() => void load(), 3000);
    });
  const disconnect = () => {
    if (!window.confirm('Disconnect GitHub? The repository on GitHub is not changed.')) return;
    void act(async () => {
      await apiSend<undefined>('DELETE', `/projects/${projectId}/github`);
      await load();
    });
  };

  if (status === null) return null;
  if (!status.available) {
    return <p className="text-[12px] text-faint">GitHub isn&apos;t set up on this server.</p>;
  }
  const { repo } = status;

  return (
    <div className="space-y-2">
      {repo ? (
        <div className="space-y-1 text-[13px]">
          <p className="text-text">
            GitHub ·{' '}
            <a
              href={repo.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono underline"
            >
              {repo.full_name}
            </a>{' '}
            <span className="text-faint">
              on <span className="font-mono">{repo.default_branch}</span>
            </span>
          </p>
          {repo.last_sync_error ? (
            <p role="status" className="text-bad">
              {repo.last_sync_error}
            </p>
          ) : (
            <p className="text-[12px] text-faint">
              {repo.last_synced_at
                ? `Synced${now ? ` ${relativeAge(repo.last_synced_at, now)}` : ''}`
                : 'Syncing…'}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[13px] text-faint">
          {status.can_manage
            ? 'Connect a GitHub repository: each approved stage is pushed there, and changes on GitHub show here.'
            : 'Not connected to GitHub. The arena owner can connect it.'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] text-bad">
          {error}
        </p>
      )}
      {status.can_manage && grant && (
        <RepoPicker
          projectId={projectId}
          grant={grant}
          onDone={(next) => {
            if (next) setStatus(next);
            clearParams();
          }}
        />
      )}
      {status.can_manage && !grant && (
        <div className="flex gap-2">
          {repo ? (
            <>
              <button
                type="button"
                className="btn h-8 px-3 text-[13px]"
                disabled={busy}
                onClick={() => void sync()}
              >
                Sync now
              </button>
              <button
                type="button"
                className="btn ghost h-8 px-2 text-[13px]"
                disabled={busy}
                onClick={disconnect}
              >
                Disconnect
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn h-8 px-3 text-[13px]"
              disabled={busy}
              onClick={() => {
                if (returned) clearParams();
                void connect();
              }}
            >
              Connect GitHub
            </button>
          )}
        </div>
      )}
    </div>
  );
}
