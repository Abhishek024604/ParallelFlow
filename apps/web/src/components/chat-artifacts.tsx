'use client';

import type { Artifact, ArtifactList, PushResult } from '@parallelflow/contracts';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { apiGet } from '../lib/api-browser';
import { artifactStatus } from '../lib/artifact-status';
import { groupByFolder, newest, splitName } from '../lib/chat-files';
import { editedAgo } from '../lib/files';
import { clampPanelWidth, isPanelWide, panelWideWidth } from '../lib/panel-width';
import { ArtifactViewer, FILES_CHANGED_EVENT } from './artifact-viewer';
import { PushDialog } from './bridge-dialogs';
import { ChevronLeftIcon, CollapseIcon, ExpandIcon, FileIcon, FolderIcon, XIcon } from './icons';

// The chat's artifacts (like Claude's side panel): every document the AI saved in this private chat
// (SWA's arch › …, the Product Manager's pm › …, specs, diagrams), on the right of the chat. It
// stays hidden until the chat has its first document, then opens on its own when the AI saves a
// new document or a new version, showing that one. A list groups the documents by folder (the
// " › " in their names); one opens in the viewer (versions, edit, approve, Push to Arena). The same
// files are also in My files. Width (drag the left edge) and open/closed are kept in this browser.

const REFRESH_MS = 15_000;
const WIDTH_KEY = 'parallelflow.chatPanel.width';
const DEFAULT_WIDTH = 440;

function viewport(): number {
  return typeof window === 'undefined' ? 1440 : window.innerWidth;
}

function readWidth(): number {
  try {
    const value = Number(window.localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value) && value > 0 ? clampPanelWidth(value, viewport()) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function storeWidth(width: number): void {
  try {
    window.localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Storage blocked: the width is not remembered.
  }
}

/**
 * The chat's artifacts panel state. `notify` is called with the document ids an AI reply saved
 * (the chat's artifact cards), so the panel refreshes at once instead of on its next poll.
 */
export function useChatArtifacts(chatId: string) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const seen = useRef<Map<string, number> | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await apiGet<ArtifactList>(
        `/artifacts?scope=private&private_session_id=${encodeURIComponent(chatId)}`,
      );
      setItems(list.items);
      const previous = seen.current;
      seen.current = new Map(list.items.map((a) => [a.id, a.head_version_no]));
      // The first load only learns what exists; later, a new document or version opens the panel.
      const fresh = previous ? newest(previous, list.items) : null;
      if (fresh) {
        setSelected(fresh.id);
        setOpen(true);
      }
    } catch {
      // Keep what is shown; the next poll tries again.
    }
  }, [chatId]);

  useEffect(() => {
    void load();
    const tick = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const timer = setInterval(tick, REFRESH_MS);
    const changed = () => void load();
    window.addEventListener(FILES_CHANGED_EVENT, changed);
    return () => {
      clearInterval(timer);
      window.removeEventListener(FILES_CHANGED_EVENT, changed);
    };
  }, [load]);

  const notify = useCallback(
    (ids: readonly string[]) => {
      if (ids.length) void load();
    },
    [load],
  );

  const show = useCallback((id: string | null) => {
    setSelected(id);
    setOpen(true);
  }, []);

  return {
    items: items ?? [],
    open,
    selected,
    setOpen,
    show,
    notify,
    reload: load,
  };
}

export type ChatArtifacts = ReturnType<typeof useChatArtifacts>;

/** The small "Files (n)" tab on the chat's right edge while the panel is closed. */
export function ChatArtifactsToggle({ state }: { state: ChatArtifacts }) {
  if (state.open || state.items.length === 0) return null;
  return (
    <button
      type="button"
      className="btn absolute right-3 top-3 z-10 h-8 gap-1.5 px-2.5 text-[13px] shadow-pop"
      onClick={() => state.show(state.selected)}
      aria-label={`Show this chat's files (${state.items.length})`}
    >
      <FileIcon size={14} />
      Files ({state.items.length})
    </button>
  );
}

export function ChatArtifactsPanel({ state }: { state: ChatArtifacts }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const narrow = useRef(DEFAULT_WIDTH);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [push, setPush] = useState<{ artifact: Artifact; versionNo: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setWidth(readWidth()), []);

  if (!state.open || state.items.length === 0) return null;

  const wide = isPanelWide(width, viewport());
  const apply = (next: number) => {
    const value = clampPanelWidth(next, viewport());
    setWidth(value);
    storeWidth(value);
  };
  const toggleWide = () => {
    if (wide) apply(narrow.current < width ? narrow.current : DEFAULT_WIDTH);
    else {
      narrow.current = width;
      apply(panelWideWidth(viewport()));
    }
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setWidth(clampPanelWidth(drag.current.width + (drag.current.x - event.clientX), viewport()));
  };
  const onPointerUp = () => {
    if (!drag.current) return;
    drag.current = null;
    storeWidth(width);
  };

  const current = state.items.find((a) => a.id === state.selected) ?? null;

  return (
    <aside
      aria-label="This chat's files"
      className="fixed inset-0 z-30 flex flex-col bg-panel md:relative md:inset-auto md:z-auto md:w-[var(--chat-panel-w)] md:shrink-0 md:border-l md:border-line"
      style={{ ['--chat-panel-w' as string]: `${width}px` }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the files panel"
        className="absolute inset-y-0 left-0 z-10 hidden w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-line2 md:block"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        {current ? (
          <button
            type="button"
            className="btn ghost h-8 gap-1 px-2 text-[13px]"
            onClick={() => state.show(null)}
          >
            <ChevronLeftIcon size={14} />
            Files
          </button>
        ) : (
          <span className="px-2 text-[14px] font-semibold text-text">
            Files in this chat · {state.items.length}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate px-1 text-[13px] text-muted">
          {current ? current.name : ''}
        </span>
        <button
          type="button"
          className="btn ghost hidden h-8 w-8 p-0 md:inline-flex"
          onClick={toggleWide}
          aria-label={wide ? 'Narrow the panel' : 'Widen the panel'}
        >
          {wide ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
        </button>
        <button
          type="button"
          className="btn ghost h-8 w-8 p-0"
          onClick={() => state.setOpen(false)}
          aria-label="Close the files panel"
        >
          <XIcon size={14} />
        </button>
      </div>
      {notice && (
        <p role="status" className="border-b border-line px-4 py-2 text-[13px] text-ok">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {current ? (
          <ArtifactViewer
            key={`${current.id}:${current.head_version_no}`}
            apiBase={`/artifacts/${encodeURIComponent(current.id)}`}
            canEdit
            canApprove
            onPush={(artifact, versionNo) => setPush({ artifact, versionNo })}
            onChanged={() => void state.reload()}
            onDeleted={() => {
              state.show(null);
              void state.reload();
            }}
          />
        ) : (
          <FileList items={state.items} onOpen={(id) => state.show(id)} />
        )}
      </div>
      {push && (
        <PushDialog
          artifact={push.artifact}
          versionNo={push.versionNo}
          onClose={() => setPush(null)}
          onPushed={(result: PushResult, arena) =>
            setNotice(`Pushed to ${arena.name} as v${result.version_no}.`)
          }
        />
      )}
    </aside>
  );
}

function FileList({ items, onOpen }: { items: readonly Artifact[]; onOpen: (id: string) => void }) {
  return (
    <div className="py-2">
      {groupByFolder(items).map((group) => (
        <section key={group.folder || 'root'} className="mb-2">
          {group.folder && (
            <h3 className="flex items-center gap-2 px-4 py-1.5 text-[12px] font-semibold uppercase tracking-wide text-faint">
              <FolderIcon size={14} />
              {group.folder}
            </h3>
          )}
          <ul>
            {group.items.map((a) => {
              const status = artifactStatus(a);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(a.id)}
                    className="nav flex w-full items-center gap-2.5 px-4 py-2 text-left"
                  >
                    <FileIcon size={16} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-text">
                        {splitName(a.name).file}
                      </span>
                      <span className="block text-[12px] text-faint">
                        v{a.head_version_no} · {editedAgo(a.updated_at)}
                      </span>
                    </span>
                    <span className={`chip ${status.tone} px-1.5 py-0.5 text-[12px]`}>
                      {status.label}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
