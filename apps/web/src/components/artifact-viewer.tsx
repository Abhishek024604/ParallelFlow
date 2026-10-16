'use client';

import {
  type Artifact,
  type ArtifactList,
  type ArtifactVersion,
  type ArtifactVersionList,
  ARTIFACT_MAX_CHARS,
  formatBytes,
  uuidv7,
} from '@saras/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiGetText, apiPost, ProblemError } from '../lib/api-browser';
import { editedAgo } from '../lib/files';
import { FileIcon, XIcon } from './icons';
import { MarkdownView } from './markdown';

// Artifact viewer (build step 6): sanitised markdown of one version, the version history, and
// "Edit", which saves a new version (versions never change). Used by My files (private, /artifacts)
// and the arena's Artifacts tab and push cards (/projects/{id}/artifacts). Content is never logged.

/** Opens the arena's artifact viewer from anywhere on the arena page (Artifacts tab, cards). */
export const OPEN_ARTIFACT_EVENT = 'saras:open-artifact';

export function openArtifact(artifactId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail: artifactId }));
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ProblemError ? (err.fieldErrors[0]?.message ?? err.detail) : fallback;

const STATUS_LABEL: Record<ArtifactVersion['status'], string> = {
  draft: 'draft',
  in_review: 'in review',
  approved: 'approved',
  superseded: 'superseded',
  discarded: 'discarded',
};

export function ArtifactViewer({
  apiBase,
  canEdit,
  onPush,
  onChanged,
}: {
  /** `/artifacts/{id}` or `/projects/{pid}/artifacts/{id}`. */
  apiBase: string;
  canEdit: boolean;
  /** Shows "Push to Arena" (private files). */
  onPush?: (artifact: Artifact, versionNo: number) => void;
  onChanged?: () => void;
}) {
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [meta, list] = await Promise.all([
        apiGet<Artifact>(apiBase),
        apiGet<ArtifactVersionList>(`${apiBase}/versions`),
      ]);
      setArtifact(meta);
      setVersions(list.items);
      setSelected(meta.head_version_no);
    } catch (err) {
      setError(errorText(err, 'Could not open this file.'));
    }
  }, [apiBase]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selected === null) return;
    const controller = new AbortController();
    setText(null);
    apiGetText(`${apiBase}/versions/${selected}/content`, controller.signal).then(
      setText,
      (err) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load this version.'));
      },
    );
    return () => controller.abort();
  }, [apiBase, selected]);

  const save = async () => {
    if (draft === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost<ArtifactVersion>(
        `${apiBase}/versions`,
        { content: draft },
        { idempotencyKey: uuidv7() },
      );
      setDraft(null);
      await load();
      onChanged?.();
    } catch (err) {
      setError(errorText(err, 'Could not save. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (!artifact) {
    return (
      <p role={error ? 'alert' : 'status'} className="p-6 text-[14px] text-muted">
        {error ?? 'Loading…'}
      </p>
    );
  }
  const current = versions.find((v) => v.version_no === selected);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <FileIcon />
        <h2 className="min-w-0 truncate font-mono text-[16px] text-text">{artifact.name}</h2>
        {selected !== null && <span className="chip px-1.5 py-0.5 text-[12px]">v{selected}</span>}
        {current && (
          <span className="text-[13px] text-faint">
            {formatBytes(current.size_bytes)} · {editedAgo(current.created_at)}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {canEdit && draft === null && (
            <button
              type="button"
              className="btn h-9 px-3 text-[14px]"
              disabled={text === null}
              onClick={() => setDraft(text ?? '')}
            >
              Edit
            </button>
          )}
          {onPush && draft === null && selected !== null && (
            <button
              type="button"
              className="btn pri h-9 px-3 text-[14px]"
              onClick={() => onPush(artifact, selected)}
            >
              Push to Arena
            </button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="px-5 pt-3 text-[13px] text-bad">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {draft !== null ? (
            <div className="flex h-full flex-col gap-3">
              <label htmlFor="artifact-draft" className="text-[12px] text-faint">
                Saving makes version {artifact.head_version_no + 1}. Earlier versions stay as they
                are.
              </label>
              <textarea
                id="artifact-draft"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={ARTIFACT_MAX_CHARS}
                className="inp min-h-[320px] flex-1 p-3 font-mono text-[14px]"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn pri h-9 px-4 text-[14px]"
                  disabled={busy}
                  onClick={() => void save()}
                >
                  {busy ? 'Saving…' : 'Save new version'}
                </button>
                <button
                  type="button"
                  className="btn ghost h-9 px-3 text-[14px]"
                  onClick={() => setDraft(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : text === null ? (
            <p className="text-[14px] text-faint">Loading…</p>
          ) : (
            <MarkdownView text={text} />
          )}
        </div>
        <aside
          aria-label="Version history"
          className="hidden w-[220px] shrink-0 overflow-y-auto border-l border-line px-3 py-4 md:block"
        >
          <h3 className="px-2 text-[12px] font-semibold uppercase tracking-wide text-faint">
            Versions
          </h3>
          <ol className="mt-2 space-y-1">
            {versions.map((v) => (
              <li key={v.version_no}>
                <button
                  type="button"
                  aria-current={v.version_no === selected ? 'true' : undefined}
                  onClick={() => setSelected(v.version_no)}
                  className={`nav w-full rounded px-2 py-1.5 text-left text-[13px] ${
                    v.version_no === selected ? 'bg-raise font-semibold text-text' : 'text-muted'
                  }`}
                >
                  v{v.version_no} · {STATUS_LABEL[v.status]}
                  <span className="block text-[12px] font-normal text-faint">
                    {v.created_by.display_name}
                    {v.source?.type === 'push' ? ' · pushed from Private' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}

/** A modal around the viewer for one arena artifact. */
export function ArenaArtifactDialog({
  projectId,
  artifactId,
  onClose,
}: {
  projectId: string;
  artifactId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label="File"
      className="card m-auto flex h-[80vh] w-[900px] max-w-[calc(100vw-32px)] flex-col p-0 text-text shadow-pop"
    >
      <div className="flex justify-end px-3 pt-3">
        <button
          type="button"
          aria-label="Close"
          className="btn ghost h-9 w-9"
          onClick={() => ref.current?.close()}
        >
          <XIcon size={18} />
        </button>
      </div>
      <ArtifactViewer
        apiBase={`/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`}
        canEdit
      />
    </dialog>
  );
}

/** The arena's Artifacts tab: newest first; opens the viewer. */
export function ArenaArtifactsList({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<ArtifactList>(`/projects/${encodeURIComponent(projectId)}/artifacts`, controller.signal)
      .then((list) => setItems(list.items))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load files.'));
      });
    return () => controller.abort();
  }, [projectId]);

  if (error)
    return (
      <p role="alert" className="text-[13px] text-bad">
        {error}
      </p>
    );
  if (!items) return <p className="text-[13px] text-faint">Loading…</p>;
  if (items.length === 0) {
    return (
      <p className="text-[14px] text-muted">
        No files yet. Push one from Private, or ask the AI to draft one.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => openArtifact(a.id)}
            className="nav flex w-full items-center gap-2 rounded px-2 py-2 text-left"
          >
            <FileIcon />
            <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-text">
              {a.name}
            </span>
            <span className="chip px-1.5 py-0.5 text-[12px]">v{a.head_version_no}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
