'use client';

import type { Artifact, ArtifactList } from '@parallelflow/contracts';
import { usePathname } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { apiGet } from '../lib/api-browser';
import { groupByStage } from '../lib/artifact-folders';
import { artifactStatus } from '../lib/artifact-status';
import { openArtifact } from './artifact-viewer';
import { ChevronDownIcon, FileIcon, FolderIcon } from './icons';

// Files under the current arena in the arena sidebar: every document of the arena (drafts and
// approved), filed in one folder per SDLC stage (Plan, Design with HLD/LLD/Architecture/UI, Build,
// Test, Deploy, Maintain), newest first inside each. Opening one shows the viewer on the arena page (latest version). The list
// refreshes every 20 s while the tab is visible, so the AI's new drafts appear.

const REFRESH_MS = 20_000;

export function ArenaFiles({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const onArenaPage = pathname === `/arena/${projectId}`;
  const [open, setOpen] = useState(true);
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () => {
      apiGet<ArtifactList>(`/projects/${encodeURIComponent(projectId)}/artifacts`)
        .then((list) => {
          if (!alive) return;
          setItems(list.items);
          setError(false);
        })
        .catch(() => {
          if (alive) setError(true);
        });
    };
    load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [projectId]);

  const listId = `arena-files-${projectId}`;
  const fileItem = (a: Artifact) => {
    const status = artifactStatus(a);
    return (
      <li key={a.id}>
        {onArenaPage ? (
          <button
            type="button"
            onClick={() => openArtifact(a.id)}
            title={`${a.name} · v${a.head_version_no} · ${status.label}${a.last_author ? ` · by ${a.last_author}` : ''}`}
            className="nav flex w-full items-center gap-2 px-2 py-1.5 text-left"
          >
            <FileRow artifact={a} status={status} />
          </button>
        ) : (
          <a
            href={`/arena/${projectId}?artifact=${a.id}`}
            className="nav flex w-full items-center gap-2 px-2 py-1.5 no-underline"
          >
            <FileRow artifact={a} status={status} />
          </a>
        )}
      </li>
    );
  };
  return (
    <div className="mb-1 ml-5 border-l border-line pl-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((v) => !v)}
        className="nav flex h-8 w-full items-center gap-2 px-2 text-left text-[13px] font-medium text-muted"
      >
        <ChevronDownIcon size={14} className={open ? '' : '-rotate-90'} />
        Files
        {items && <span className="ml-auto text-[12px] text-faint">{items.length}</span>}
      </button>
      {open && (
        <ul id={listId} className="space-y-0.5">
          {error && !items ? (
            <li className="px-2 py-1 text-[12px] text-faint">Could not load files</li>
          ) : !items ? (
            <li className="px-2 py-1 text-[12px] text-faint">Loading…</li>
          ) : items.length === 0 ? (
            <li className="px-2 py-1 text-[12px] text-faint">No files yet</li>
          ) : (
            groupByStage(items).map((folder) => (
              <Folder key={folder.stage} label={folder.label} count={folder.count}>
                {folder.subfolders.map((sub) => (
                  <Folder key={sub.key} label={sub.label} count={sub.files.length}>
                    {sub.files.map(fileItem)}
                  </Folder>
                ))}
                {folder.files.map(fileItem)}
              </Folder>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

/** A collapsible stage (or Design sub-) folder; folders with files start open. */
function Folder({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(count > 0);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
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
