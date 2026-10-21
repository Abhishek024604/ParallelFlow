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
import { isApproved } from '../lib/artifact-status';
import { editedAgo, readableTime } from '../lib/files';
import { FullScreenButton, FullScreenView } from './full-screen';
import { FileIcon, XIcon } from './icons';
import { DocumentBody } from './diagram-view';

// Artifact viewer (build step 6): sanitised markdown of one version, the version history, and
// "Edit", which saves a new version (versions never change). Used by My files (private, /artifacts)
// and the arena's Artifacts tab and push cards (/projects/{id}/artifacts). Content is never logged.

/** Opens the arena's artifact viewer from anywhere on the arena page (Artifacts tab, cards). */
export const OPEN_ARTIFACT_EVENT = 'saras:open-artifact';

/** What an OPEN_ARTIFACT_EVENT carries: the artifact, and optionally the version to show first. */
export interface OpenArtifactRequest {
  id: string;
  versionNo?: number;
}

export function openArtifact(artifactId: string, versionNo?: number): void {
  const detail: OpenArtifactRequest = { id: artifactId, ...(versionNo && { versionNo }) };
  window.dispatchEvent(new CustomEvent(OPEN_ARTIFACT_EVENT, { detail }));
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

/** "Pushed from Private v3 by Asha" (the private numbering is the pusher's own). */
export function pushedFromLabel(v: ArtifactVersion): string {
  const from = v.source?.private_version_no ? `Private v${v.source.private_version_no}` : 'Private';
  const by = v.source?.pushed_by?.display_name ?? v.created_by.display_name;
  return `Pushed from ${from} by ${by}`;
}

/** Who made a version and how: the server's plain label, else the author. */
export function versionByLine(v: ArtifactVersion): string {
  if (v.source?.label) return v.source.label;
  return v.source?.type === 'push' ? pushedFromLabel(v) : v.created_by.display_name;
}

export function ArtifactViewer({
  apiBase,
  canEdit,
  canApprove = false,
  initialVersion,
  onPush,
  onChanged,
}: {
  /** `/artifacts/{id}` or `/projects/{pid}/artifacts/{id}`. */
  apiBase: string;
  canEdit: boolean;
  /**
   * The arena owner: "Approve this version" on the latest version of an architecture document
   * (arch/…, the AI's SWA gates read these approvals). Other documents are approved with their gate.
   */
  canApprove?: boolean;
  /** The version shown first (e.g. the approved one); the latest when unset. */
  initialVersion?: number;
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
  const [fullScreen, setFullScreen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [meta, list] = await Promise.all([
        apiGet<Artifact>(apiBase),
        apiGet<ArtifactVersionList>(`${apiBase}/versions`),
      ]);
      setArtifact(meta);
      setVersions(list.items);
      setSelected((current) =>
        current === null &&
        initialVersion &&
        list.items.some((v) => v.version_no === initialVersion)
          ? initialVersion
          : meta.head_version_no,
      );
    } catch (err) {
      setError(errorText(err, 'Could not open this file.'));
    }
  }, [apiBase, initialVersion]);

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

  const approve = async () => {
    if (!artifact || busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost<Artifact>(`${apiBase}/approve`, { version_no: artifact.head_version_no });
      await load();
      onChanged?.();
    } catch (err) {
      setError(errorText(err, 'Could not approve. Please try again.'));
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
  const approvable =
    canApprove &&
    artifact.scope === 'project' &&
    artifact.name.startsWith('arch/') &&
    selected === artifact.head_version_no &&
    artifact.approved_version_no !== artifact.head_version_no;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
        <FileIcon />
        <h2 className="min-w-0 truncate font-mono text-[16px] text-text">{artifact.name}</h2>
        {selected !== null && <span className="chip px-1.5 py-0.5 text-[12px]">v{selected}</span>}
        {current && (
          <span className="text-[13px] text-faint">
            {formatBytes(current.size_bytes)} · {versionByLine(current)} ·{' '}
            {editedAgo(current.created_at)}
          </span>
        )}
        <span className="ml-auto flex gap-2">
          {draft === null && (
            <FullScreenButton disabled={text === null} onClick={() => setFullScreen(true)} />
          )}
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
          {approvable && draft === null && (
            <button
              type="button"
              className="btn pri h-9 px-3 text-[14px]"
              disabled={busy || text === null}
              onClick={() => void approve()}
            >
              {busy ? 'Approving…' : `Approve v${artifact.head_version_no}`}
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
            <DocumentBody name={artifact.name} text={text} />
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
                  {artifact.scope === 'project' ? 'Arena ' : ''}v{v.version_no} ·{' '}
                  {STATUS_LABEL[v.status]}
                  <span className="block text-[12px] font-normal text-faint">
                    {versionByLine(v)}
                  </span>
                  <span className="block text-[12px] font-normal text-faint">
                    <time dateTime={v.created_at}>{readableTime(v.created_at)}</time>
                  </span>
                  {v.approved_by_name && (
                    <span className="block text-[12px] font-normal text-ok">
                      Approved by {v.approved_by_name}
                      {v.approved_at ? ` · ${readableTime(v.approved_at)}` : ''}
                    </span>
                  )}
                  {v.pushed_to?.map((p) => (
                    <span
                      key={`${p.project_id}:${p.arena_version_no}`}
                      className="block text-[12px] font-normal text-faint"
                    >
                      Pushed to {p.arena_name} as v{p.arena_version_no}
                    </span>
                  ))}
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>
      {fullScreen && text !== null && (
        <FullScreenView
          title={artifact.name}
          meta={
            current
              ? `v${current.version_no} · ${STATUS_LABEL[current.status]} · ${versionByLine(current)} · ${readableTime(current.created_at)}`
              : undefined
          }
          onClose={() => setFullScreen(false)}
        >
          <DocumentBody name={artifact.name} text={text} />
        </FullScreenView>
      )}
    </div>
  );
}

/** A modal around the viewer for one arena artifact. */
export function ArenaArtifactDialog({
  projectId,
  artifactId,
  versionNo,
  canApprove = false,
  onClose,
}: {
  projectId: string;
  artifactId: string;
  versionNo?: number;
  /** The viewer is the arena owner (approves arch/ documents). */
  canApprove?: boolean;
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
        canApprove={canApprove}
        {...(versionNo && { initialVersion: versionNo })}
      />
    </dialog>
  );
}

/**
 * The arena's Approved tab: documents with an approved version (committed to the arena's repo on
 * the gate's approval), newest first; opens the approved version. Drafts are in the sidebar's Files.
 */
export function ArenaArtifactsList({ projectId }: { projectId: string }) {
  const [all, setAll] = useState<Artifact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<ArtifactList>(`/projects/${encodeURIComponent(projectId)}/artifacts`, controller.signal)
      .then((list) => setAll(list.items))
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load files.'));
      });
    return () => controller.abort();
  }, [projectId]);
  const items = all?.filter(isApproved) ?? null;

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
        Nothing approved yet. A document is approved with its stage gate, and then appears here.
        Drafts are under Files in the left sidebar.
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => openArtifact(a.id, a.approved_version_no ?? undefined)}
            className="nav flex w-full items-center gap-2 rounded px-2 py-2 text-left"
          >
            <FileIcon />
            <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-text">
              {a.name}
            </span>
            {a.last_author && (
              <span className="shrink-0 text-[12px] text-faint">by {a.last_author}</span>
            )}
            <span className="chip ok px-1.5 py-0.5 text-[12px]">
              v{a.approved_version_no} · approved
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
