'use client';

import type { ArenaRepo } from '@saras/contracts';
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiGetText, ProblemError } from '../lib/api-browser';
import { relativeAge } from '../lib/chat';
import { FileIcon } from './icons';
import { MarkdownView } from './markdown';

// The arena's git repository in the Overview panel: one commit per approved gate (who approved it,
// when), and the files at the latest commit (README, progress.md, approved documents by cycle and
// stage). A file opens read-only. Refreshed while the page is visible, so an approval shows up here
// within a few seconds.

const POLL_MS = 10_000;

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function FileDialog({
  projectId,
  path,
  onClose,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    const abort = new AbortController();
    apiGetText(`/projects/${projectId}/repo/file?path=${encodeURIComponent(path)}`, abort.signal)
      .then(setText)
      .catch((err: unknown) => {
        if (!abort.signal.aborted) {
          setError(err instanceof ProblemError ? err.detail : 'This file could not be opened.');
        }
      });
    return () => abort.abort();
  }, [projectId, path]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="repo-file-title"
      className="card m-auto w-[760px] max-w-[calc(100vw-32px)] p-0 text-text shadow-pop"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-4">
        <FileIcon size={16} />
        <h2 id="repo-file-title" className="min-w-0 flex-1 truncate font-mono text-[14px]">
          {path}
        </h2>
        <button
          type="button"
          className="btn h-8 px-3 text-[13px]"
          onClick={() => ref.current?.close()}
        >
          Close
        </button>
      </div>
      <div className="max-h-[70vh] overflow-auto px-6 py-5">
        {error ? (
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
        ) : text === null ? (
          <p className="text-[13px] text-faint">Loading…</p>
        ) : path.endsWith('.md') ? (
          <MarkdownView text={text} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[13px]">{text}</pre>
        )}
      </div>
    </dialog>
  );
}

export function ArenaRepoPanel({ projectId }: { projectId: string }) {
  const [repo, setRepo] = useState<ArenaRepo | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      apiGet<ArenaRepo>(`/projects/${projectId}/repo`)
        .then((next) => {
          if (!alive) return;
          setRepo(next);
          setFailed(false);
          setNow(new Date());
        })
        .catch(() => alive && setFailed(true));
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  return (
    <section>
      <h2 className="label">Repository</h2>
      {repo === null ? (
        <p className="mt-2 text-[13px] text-faint">
          {failed ? 'The repository could not be loaded.' : 'Loading…'}
        </p>
      ) : repo.commits.length === 0 ? (
        <p className="mt-2 text-[13px] text-faint">
          Every approved stage is committed here, with the approved documents and progress. Nothing
          is approved yet.
        </p>
      ) : (
        <div className="mt-2 space-y-3">
          <p className="text-[12px] text-faint">
            Branch <span className="font-mono text-muted">{repo.branch}</span> ·{' '}
            {repo.commits.length} {repo.commits.length === 1 ? 'commit' : 'commits'} · kept on the
            server
          </p>
          <ul className="card divide-y divide-line" aria-label="Files">
            {repo.files.map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setOpen(file.path)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-side"
                >
                  <FileIcon size={14} />
                  <span className="min-w-0 flex-1 truncate font-mono text-text">{file.path}</span>
                </button>
              </li>
            ))}
          </ul>
          <ol className="space-y-2" aria-label="Commits">
            {repo.commits.slice(0, 8).map((commit) => (
              <li key={commit.sha} className="flex items-start gap-2 text-[13px]">
                <span className="chip shrink-0 px-1.5 py-0 font-mono text-[11px]">
                  {shortSha(commit.sha)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-text">{commit.message}</div>
                  <div className="text-[12px] text-faint">
                    {commit.author}
                    {now && ` · ${relativeAge(commit.at, now)}`}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {open && <FileDialog projectId={projectId} path={open} onClose={() => setOpen(null)} />}
    </section>
  );
}
