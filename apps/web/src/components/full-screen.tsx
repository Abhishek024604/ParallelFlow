'use client';

import type { Artifact, ArtifactVersion } from '@saras/contracts';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { apiGet, apiGetText, apiPost, ProblemError } from '../lib/api-browser';
import { rendersAsMarkdown } from '../lib/files';
import { DocumentBody } from './diagram-view';
import { CollapseIcon, ExpandIcon, FileIcon } from './icons';
import { MarkdownView } from './markdown';

// Full-screen reading of a file: a modal <dialog> over the whole window (the browser traps focus
// inside it, Esc closes it, and focus returns to the button that opened it). Used by the artifact
// viewer (arena Files/Approved, My files, file pages), the repo file dialog and the private chat's
// file links. Content is never logged.

export function FullScreenView({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  /** Version info under the title, e.g. "v3 · draft · Asha · 18 Oct, 14:05". */
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const exit = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    exit.current?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="full-screen-title"
      aria-describedby={meta ? 'full-screen-meta' : undefined}
      className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-panel p-0 text-text"
    >
      <header className="flex items-center gap-3 border-b border-line px-6 py-3">
        <FileIcon />
        <div className="min-w-0 flex-1">
          <h2 id="full-screen-title" className="truncate font-mono text-[16px] text-text">
            {title}
          </h2>
          {meta && (
            <p id="full-screen-meta" className="truncate text-[13px] text-faint">
              {meta}
            </p>
          )}
        </div>
        <span className="hidden text-[12px] text-faint sm:inline">Esc to exit</span>
        <button
          ref={exit}
          type="button"
          className="btn h-9 gap-2 px-3 text-[14px]"
          onClick={() => ref.current?.close()}
        >
          <CollapseIcon size={14} />
          Exit full screen
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[920px] px-6 py-8">{children}</div>
      </div>
    </dialog>
  );
}

/** The "Full screen" button. */
export function FullScreenButton({
  onClick,
  disabled,
  compact = false,
  label = 'Full screen',
}: {
  onClick: () => void;
  disabled?: boolean;
  /** Icon only (in a chip row). */
  compact?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={compact ? label : undefined}
      title={label}
      className={compact ? 'btn ghost h-7 w-7 p-0' : 'btn h-9 gap-2 px-3 text-[14px]'}
    >
      <ExpandIcon size={14} />
      {!compact && 'Full screen'}
    </button>
  );
}

/** A text file's body: Markdown rendered, anything else as plain text. */
export function FileBody({ name, text }: { name: string; text: string }) {
  return rendersAsMarkdown(name) ? (
    <MarkdownView text={text} />
  ) : (
    <pre className="whitespace-pre-wrap break-words font-mono text-[14px]">{text}</pre>
  );
}

/** Loads one artifact version (the latest by default) and shows it full screen. */
export function ArtifactFullScreen({
  apiBase,
  versionNo,
  canApprove = false,
  onClose,
}: {
  /** `/artifacts/{id}` or `/projects/{pid}/artifacts/{id}`. */
  apiBase: string;
  versionNo?: number;
  /** "Approve vN" on the latest version of an architecture document (arch/…, SWA's gates). */
  canApprove?: boolean;
  onClose: () => void;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [version, setVersion] = useState<ArtifactVersion | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);
  const approvable =
    canApprove &&
    !!artifact &&
    artifact.name.startsWith('arch/') &&
    version?.version_no === artifact.head_version_no &&
    artifact.approved_version_no !== artifact.head_version_no;
  const approve = async () => {
    if (!artifact || approving) return;
    setApproving(true);
    setApproveError(null);
    try {
      setArtifact(
        await apiPost<Artifact>(`${apiBase}/approve`, { version_no: artifact.head_version_no }),
      );
      setVersion((v) => (v ? { ...v, status: 'approved' } : v));
    } catch (err) {
      setApproveError(
        err instanceof ProblemError ? err.detail : 'Could not approve. Please try again.',
      );
    } finally {
      setApproving(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const meta = await apiGet<Artifact>(apiBase, controller.signal);
        const no = versionNo ?? meta.head_version_no;
        const [list, body] = await Promise.all([
          apiGet<{ items: ArtifactVersion[] }>(`${apiBase}/versions`, controller.signal),
          apiGetText(`${apiBase}/versions/${no}/content`, controller.signal),
        ]);
        setArtifact(meta);
        setVersion(list.items.find((v) => v.version_no === no) ?? null);
        setText(body);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof ProblemError ? err.detail : 'Could not open this file.');
        }
      }
    })();
    return () => controller.abort();
  }, [apiBase, versionNo]);
  return (
    <FullScreenView
      title={artifact?.name ?? 'File'}
      meta={
        version ? (
          <>
            v{version.version_no} · {version.status.replace('_', ' ')}
            {approvable && (
              <button
                type="button"
                className="btn pri ml-3 h-8 px-3 text-[13px]"
                disabled={approving}
                onClick={() => void approve()}
              >
                {approving ? 'Approving…' : `Approve v${version.version_no}`}
              </button>
            )}
            {approveError && (
              <span role="alert" className="ml-3 text-bad">
                {approveError}
              </span>
            )}
          </>
        ) : undefined
      }
      onClose={onClose}
    >
      {error ? (
        <p role="alert" className="text-[14px] text-bad">
          {error}
        </p>
      ) : text === null ? (
        <p className="text-[14px] text-faint">Loading…</p>
      ) : (
        <DocumentBody name={artifact?.name ?? ''} text={text} />
      )}
    </FullScreenView>
  );
}
