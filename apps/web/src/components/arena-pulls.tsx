'use client';

import type {
  BranchList,
  BranchSummary,
  PullFile,
  PullRequestDetail,
  PullRequestList,
  PullRequestStatus,
  PullRequestSummary,
  ReviewDecision,
} from '@saras/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, ProblemError } from '../lib/api-browser';
import { relativeAge } from '../lib/chat';
import { MarkdownView } from './markdown';

// Code review in the arena (ADR-037): the Overview's Pull requests and Branches lists, and the pull
// request view (description, commits, a unified diff per file, reviews, and Approve / Request changes
// / Comment, Merge and Close for those allowed). AI coding tasks from VS Code open these PRs; only
// teammates with "Approve and merge pull requests" approve and merge, never the author.

const POLL_MS = 10_000;

const STATUS: Record<PullRequestStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: '' },
  approved: { label: 'Approved', tone: 'ok' },
  changes_requested: { label: 'Changes requested', tone: 'warn' },
  merged: { label: 'Merged', tone: 'ok' },
  closed: { label: 'Closed', tone: '' },
};

function StatusChip({ status }: { status: PullRequestStatus }) {
  const s = STATUS[status];
  return <span className={`chip ${s.tone} shrink-0 px-1.5 py-0 text-[11px]`}>{s.label}</span>;
}

function message(err: unknown): string {
  return err instanceof ProblemError ? err.detail : 'Something went wrong. Please try again.';
}

/** One diff line's colours: added (sage), removed (bad), hunk headers muted. Tokens only. */
function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-faint';
  if (line.startsWith('+')) return 'bg-ok-soft text-ok';
  if (line.startsWith('-')) return 'bg-bad-soft text-bad';
  if (line.startsWith('@@')) return 'bg-raise text-faint';
  return 'text-muted';
}

function DiffFile({ file }: { file: PullFile }) {
  // The `diff --git` / `index` header lines repeat the file name: start at the first ---/@@ line.
  const lines = (file.patch ?? '').replace(/\n$/, '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('---') || l.startsWith('@@'));
  const body = start >= 0 ? lines.slice(start) : [];
  return (
    <details open={body.length < 400} className="card overflow-hidden">
      <summary className="flex cursor-pointer items-center gap-2 bg-side px-3 py-2 text-[13px]">
        <span className="min-w-0 flex-1 truncate font-mono text-text">{file.path}</span>
        <span className="chip px-1.5 py-0 text-[11px]">{file.status}</span>
        <span className="font-mono text-[12px] text-ok">+{file.additions}</span>
        <span className="font-mono text-[12px] text-bad">−{file.deletions}</span>
      </summary>
      {file.patch === null ? (
        <p className="px-3 py-2 text-[12px] text-faint">
          {file.truncated ? 'This diff is too large to show here.' : 'Binary file.'}
        </p>
      ) : (
        <pre className="overflow-x-auto border-t border-line font-mono text-[12px] leading-[18px]">
          {body.map((line, i) => (
            <div key={i} className={`whitespace-pre px-3 ${lineClass(line)}`}>
              {line || ' '}
            </div>
          ))}
        </pre>
      )}
    </details>
  );
}

const DECISION_LABEL: Record<ReviewDecision, string> = {
  approve: 'approved',
  request_changes: 'requested changes',
  comment: 'commented',
};

export function PullRequestView({
  projectId,
  number,
  onClose,
}: {
  projectId: string;
  number: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [pr, setPr] = useState<PullRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      setPr(await apiGet<PullRequestDetail>(`/projects/${projectId}/pulls/${number}`));
      setNow(new Date());
    } catch (err) {
      setError(message(err));
    }
  }, [projectId, number]);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    void load();
  }, [load]);

  async function act(path: string, payload?: unknown) {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/projects/${projectId}/pulls/${number}/${path}`, payload);
      setBody('');
      await load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="pr-title"
      className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-panel p-0 text-text"
    >
      <header className="flex items-center gap-3 border-b border-line px-6 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="pr-title" className="truncate text-[16px] font-semibold text-text">
            {pr ? `#${pr.number} ${pr.title}` : `Pull request #${number}`}
          </h2>
          {pr && (
            <p className="truncate text-[13px] text-faint">
              <span className="font-mono">{pr.branch}</span> → main · opened by{' '}
              {pr.author.display_name}
              {pr.author_kind === 'ai' && ' (written by AI)'}
              {now && ` · ${relativeAge(pr.created_at, now)}`}
            </p>
          )}
        </div>
        {pr && <StatusChip status={pr.status} />}
        <button
          type="button"
          className="btn h-9 px-3 text-[14px]"
          onClick={() => ref.current?.close()}
        >
          Close
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[980px] space-y-6 px-6 py-6">
          {error && (
            <p role="alert" className="chip bad px-3 py-2 text-[13px]">
              {error}
            </p>
          )}
          {!pr ? (
            !error && <p className="text-[13px] text-faint">Loading…</p>
          ) : (
            <>
              {pr.author_kind === 'ai' && (
                <p className="chip ai inline-block px-2 py-0.5 text-[12px]">
                  Written by AI in VS Code · {pr.author.display_name} is accountable for it
                </p>
              )}
              <section>
                {pr.description ? (
                  <MarkdownView text={pr.description} />
                ) : (
                  <p className="text-[13px] text-faint">No description.</p>
                )}
              </section>

              <section>
                <h3 className="label">Commits ({pr.commits.length})</h3>
                <ol className="mt-2 space-y-1.5">
                  {pr.commits.map((c) => (
                    <li key={c.sha} className="flex items-start gap-2 text-[13px]">
                      <span className="chip shrink-0 px-1.5 py-0 font-mono text-[11px]">
                        {c.sha.slice(0, 7)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text">{c.message}</span>
                      <span className="shrink-0 text-[12px] text-faint">{c.author}</span>
                    </li>
                  ))}
                </ol>
              </section>

              <section>
                <h3 className="label">Files changed ({pr.files.length})</h3>
                {pr.diff_truncated && (
                  <p className="mt-1 text-[12px] text-faint">
                    Some files are too large to show; clone the branch to see everything.
                  </p>
                )}
                <div className="mt-2 space-y-3">
                  {pr.files.map((f) => (
                    <DiffFile key={f.path} file={f} />
                  ))}
                </div>
              </section>

              <section>
                <h3 className="label">Reviews</h3>
                {pr.reviews.length === 0 ? (
                  <p className="mt-2 text-[13px] text-faint">No reviews yet.</p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {pr.reviews.map((r) => (
                      <li key={r.id} className="card px-3 py-2 text-[13px]">
                        <div className="text-text">
                          <strong>{r.reviewer.display_name}</strong> {DECISION_LABEL[r.decision]}
                          <span className="text-faint">
                            {' '}
                            · {r.head_sha === pr.head_sha ? 'latest commits' : 'earlier commits'}
                            {now && ` · ${relativeAge(r.created_at, now)}`}
                          </span>
                        </div>
                        {r.body && <p className="mt-1 whitespace-pre-wrap text-muted">{r.body}</p>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {pr.viewer.can_review && (
                <section className="card p-4">
                  <label htmlFor="pr-review" className="label">
                    Your review
                  </label>
                  <textarea
                    id="pr-review"
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={3}
                    maxLength={10000}
                    placeholder="What looks good, and what should change?"
                    className="inp mt-2 w-full px-3 py-2 text-[14px]"
                  />
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="btn pri h-9 px-4"
                      disabled={busy || !pr.viewer.can_approve}
                      title={
                        pr.viewer.is_author
                          ? 'You cannot approve your own pull request'
                          : pr.viewer.can_approve
                            ? undefined
                            : 'Only teammates who can merge pull requests can approve'
                      }
                      onClick={() => void act('reviews', { decision: 'approve', body })}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="btn h-9 px-4"
                      disabled={busy || !body.trim()}
                      onClick={() => void act('reviews', { decision: 'request_changes', body })}
                    >
                      Request changes
                    </button>
                    <button
                      type="button"
                      className="btn ghost h-9 px-4"
                      disabled={busy || !body.trim()}
                      onClick={() => void act('reviews', { decision: 'comment', body })}
                    >
                      Comment
                    </button>
                  </div>
                </section>
              )}

              {(pr.status === 'open' ||
                pr.status === 'approved' ||
                pr.status === 'changes_requested') && (
                <section className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
                  <button
                    type="button"
                    className="btn pri h-10 px-5"
                    disabled={busy || !pr.viewer.can_merge}
                    onClick={() => void act('merge')}
                  >
                    Merge into main
                  </button>
                  {pr.viewer.can_close && (
                    <button
                      type="button"
                      className="btn ghost h-10 px-4"
                      disabled={busy}
                      onClick={() => void act('close')}
                    >
                      Close pull request
                    </button>
                  )}
                  {pr.merge_blocker && (
                    <span className="text-[13px] text-faint">{pr.merge_blocker}</span>
                  )}
                </section>
              )}
              {pr.status === 'merged' && pr.merged_by && (
                <p className="chip ok inline-block px-2 py-1 text-[13px]">
                  Merged into main by {pr.merged_by.display_name}
                  {pr.merge_sha && ` · ${pr.merge_sha.slice(0, 7)}`}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

/** Overview → Repository: pull requests and `ai/*` branches. Opens a PR from `?pr=<n>` too. */
export function ArenaCodePanel({
  projectId,
  initialPr,
}: {
  projectId: string;
  initialPr: number | null;
}) {
  const [pulls, setPulls] = useState<PullRequestSummary[] | null>(null);
  const [branches, setBranches] = useState<BranchSummary[]>([]);
  const [open, setOpen] = useState<number | null>(initialPr);
  const [now, setNow] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, b] = await Promise.all([
        apiGet<PullRequestList>(`/projects/${projectId}/pulls`),
        apiGet<BranchList>(`/projects/${projectId}/branches`),
      ]);
      setPulls(p.items);
      setBranches(b.items);
      setNow(new Date());
    } catch {
      setPulls((prev) => prev ?? []);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => setOpen(initialPr), [initialPr]);

  if (pulls === null) return null;
  return (
    <div className="mt-4 space-y-4">
      <div>
        <h3 className="label">Pull requests</h3>
        {pulls.length === 0 ? (
          <p className="mt-1 text-[13px] text-faint">
            None yet. AI coding tasks from VS Code open pull requests here for review.
          </p>
        ) : (
          <ul className="card mt-2 divide-y divide-line" aria-label="Pull requests">
            {pulls.slice(0, 20).map((pr) => (
              <li key={pr.number}>
                <button
                  type="button"
                  onClick={() => setOpen(pr.number)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] hover:bg-side"
                >
                  <span className="font-mono text-faint">#{pr.number}</span>
                  <span className="min-w-0 flex-1 truncate text-text">{pr.title}</span>
                  <StatusChip status={pr.status} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {branches.length > 0 && (
        <div>
          <h3 className="label">Branches</h3>
          <ul className="mt-2 space-y-1.5" aria-label="Branches">
            {branches.slice(0, 20).map((b) => (
              <li key={b.name} className="flex items-center gap-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-mono text-text">{b.name}</span>
                <span className="shrink-0 text-[12px] text-faint">
                  {b.ahead} ahead{now && ` · ${relativeAge(b.updated_at, now)}`}
                </span>
                {b.pull_request && (
                  <button
                    type="button"
                    className="chip shrink-0 px-1.5 py-0 text-[11px]"
                    onClick={() => setOpen(b.pull_request?.number ?? null)}
                  >
                    #{b.pull_request.number}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {open !== null && (
        <PullRequestView
          projectId={projectId}
          number={open}
          onClose={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </div>
  );
}
