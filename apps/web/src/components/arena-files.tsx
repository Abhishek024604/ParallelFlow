'use client';

import type { Artifact, ArtifactList, SdlcStage } from '@parallelflow/contracts';
import { usePathname } from 'next/navigation';
import type React from 'react';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { apiGet, apiSend } from '../lib/api-browser';
import { arenaLogs, groupByStage, visibleCount } from '../lib/artifact-folders';
import { artifactStatus } from '../lib/artifact-status';
import { requestCopyToChat, startFileDrag } from '../lib/file-drag';
import { FILES_CHANGED_EVENT, openArtifact } from './artifact-viewer';
import { ConfirmDialog } from './dialog';
import { ChevronDownIcon, FileIcon, FolderIcon } from './icons';
import { RowMenu } from './row-menu';

// Files under the current arena in the arena sidebar: every document of the arena (drafts and
// approved), filed in one folder per SDLC stage (Plan, Design, Build, Test, Deploy, Maintain) by its
// standard name, newest first inside each. PROGRESS.md and STATE.md cover the whole arena, so they
// sit above the folders. "Files" and every folder collapse on click; what is open is remembered per
// arena in this browser. The owner can delete a file (soft delete, ADR-038). The list refreshes
// every 20 s while the tab is visible, so the AI's new drafts appear.

const REFRESH_MS = 20_000;

type OpenState = { files: boolean; folders: Partial<Record<SdlcStage, boolean>> };

function useOpenState(projectId: string) {
  const key = `parallelflow.files.${projectId}`;
  const [state, setState] = useState<OpenState>({ files: true, folders: {} });
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(key);
      if (saved) setState(JSON.parse(saved) as OpenState);
    } catch {
      // Storage blocked or bad data: the defaults.
    }
  }, [key]);
  const update = useCallback(
    (next: (s: OpenState) => OpenState) =>
      setState((current) => {
        const value = next(current);
        try {
          window.localStorage.setItem(key, JSON.stringify(value));
        } catch {
          // Not remembered; still works.
        }
        return value;
      }),
    [key],
  );
  return [state, update] as const;
}

export function ArenaFiles({
  projectId,
  isOwner,
  readOnly,
  stage,
}: {
  projectId: string;
  isOwner: boolean;
  /** Archived arena: nothing can be changed. */
  readOnly: boolean;
  /** The arena's current stage: its folder starts open. */
  stage: SdlcStage | null;
}) {
  const pathname = usePathname();
  const onArenaPage = pathname === `/arena/${projectId}`;
  const [open, setOpen] = useOpenState(projectId);
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState(false);
  const [deleting, setDeleting] = useState<Artifact | null>(null);

  const load = useCallback(() => {
    return apiGet<ArtifactList>(`/projects/${encodeURIComponent(projectId)}/artifacts`)
      .then((list) => {
        setItems(list.items);
        setError(false);
      })
      .catch(() => setError(true));
  }, [projectId]);

  useEffect(() => {
    let alive = true;
    const run = () => {
      if (alive) void load();
    };
    run();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, REFRESH_MS);
    window.addEventListener(FILES_CHANGED_EVENT, run);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener(FILES_CHANGED_EVENT, run);
    };
  }, [load]);

  const canDelete = (a: Artifact) =>
    isOwner && !readOnly && a.kind !== 'progress' && a.kind !== 'stage_summary';

  const listId = `arena-files-${projectId}`;
  const fileItem = (a: Artifact) => {
    const status = artifactStatus(a);
    const title = `${a.name} · v${a.head_version_no} · ${status.label}${a.last_author ? ` · by ${a.last_author}` : ''}`;
    // Drag onto a private chat or Private (ADR-041): copies it, ids only.
    const drag = {
      draggable: true,
      onDragStart: (event: React.DragEvent) =>
        startFileDrag(event, { kind: 'arena', project_id: projectId, artifact_id: a.id }),
    };
    const copy = () => requestCopyToChat({ projectId, artifactIds: [a.id] });
    return (
      <li key={a.id} className="group flex items-center" {...drag}>
        {onArenaPage ? (
          <button
            type="button"
            onClick={() => openArtifact(a.id)}
            title={title}
            className="nav flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
          >
            <FileRow artifact={a} status={status} />
          </button>
        ) : (
          <a
            href={`/arena/${projectId}?artifact=${a.id}`}
            title={title}
            className="nav flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 no-underline"
          >
            <FileRow artifact={a} status={status} />
          </a>
        )}
        <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <RowMenu
            label={`Actions for ${a.name}`}
            items={[
              { label: 'Copy to my chat', onSelect: copy },
              ...(canDelete(a)
                ? [{ label: 'Delete file', danger: true, onSelect: () => setDeleting(a) }]
                : []),
            ]}
          />
        </span>
      </li>
    );
  };

  const folderOpen = (s: SdlcStage, count: number) => open.folders[s] ?? (count > 0 || s === stage);

  return (
    <div className="mb-1 ml-5 border-l border-line pl-2">
      <button
        type="button"
        aria-expanded={open.files}
        aria-controls={listId}
        onClick={() => setOpen((s) => ({ ...s, files: !s.files }))}
        className="nav flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] font-medium text-muted"
      >
        <ChevronDownIcon size={14} className={open.files ? '' : '-rotate-90'} />
        Files
        {items && <span className="ml-auto text-[12px] text-faint">{visibleCount(items)}</span>}
      </button>
      {open.files && (
        <ul id={listId} className="space-y-0.5">
          {error && !items ? (
            <li className="px-2 py-1 text-[12px] text-faint">Could not load files</li>
          ) : !items ? (
            <li className="px-2 py-1 text-[12px] text-faint">Loading…</li>
          ) : visibleCount(items) === 0 ? (
            <li className="px-2 py-1 text-[12px] text-faint">No files yet</li>
          ) : (
            <>
              {arenaLogs(items).map(fileItem)}
              {groupByStage(items).map((folder) => (
                <Folder
                  key={folder.stage}
                  label={folder.label}
                  count={folder.files.length}
                  open={folderOpen(folder.stage, folder.files.length)}
                  onToggle={() =>
                    setOpen((s) => ({
                      ...s,
                      folders: {
                        ...s.folders,
                        [folder.stage]: !folderOpen(folder.stage, folder.files.length),
                      },
                    }))
                  }
                >
                  {folder.files.map(fileItem)}
                </Folder>
              ))}
            </>
          )}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          body={
            <>
              It disappears from this arena for everyone, with all its versions. The arena keeps a
              record that it was deleted. This cannot be undone here.
            </>
          }
          confirmLabel="Delete file"
          danger
          onConfirm={async () => {
            await apiSend<undefined>(
              'DELETE',
              `/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(deleting.id)}`,
            );
            await load();
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function Folder({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="nav flex h-7 w-full items-center gap-1.5 px-2 text-left text-[13px] text-text"
      >
        <ChevronDownIcon size={12} className={`shrink-0 text-faint ${open ? '' : '-rotate-90'}`} />
        <FolderIcon size={14} className="shrink-0 text-faint" />
        <span className="flex-1 truncate">{label}</span>
        <span className="text-[11px] text-faint">{count}</span>
      </button>
      {open && (
        <ul className="ml-3 space-y-0.5 border-l border-line pl-1">
          {count === 0 ? <li className="px-2 py-1 text-[12px] text-faint">Empty</li> : children}
        </ul>
      )}
    </li>
  );
}

function FileRow({
  artifact,
  status,
}: {
  artifact: Artifact;
  status: { label: string; tone: string };
}) {
  return (
    <>
      <FileIcon size={14} className="shrink-0 text-faint" />
      <span className="min-w-0 flex-1 truncate text-[13px] text-text">
        {artifact.name}
        {artifact.last_author && (
          <span className="block truncate text-[11px] text-faint">by {artifact.last_author}</span>
        )}
      </span>
      <span className="shrink-0 text-[11px] text-faint">v{artifact.head_version_no}</span>
      <span className={`chip shrink-0 px-1 text-[10px] leading-4 ${status.tone}`}>
        {status.label}
      </span>
    </>
  );
}
