'use client';

import type { Artifact, ArtifactList, LinkedArena, PushResult } from '@parallelflow/contracts';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { apiGet } from '../lib/api-browser';
import { artifactStatus, isApproved } from '../lib/artifact-status';
import { announce, DROP_OVER, requestCopyToChat, useDropTarget } from '../lib/file-drag';
import { copyArenaFiles } from './bridge-dialogs';
import { useFileMoves } from './file-moves';
import { RowMenu } from './row-menu';
import { docPlace, newest } from '../lib/chat-files';
import { DocTree, type FolderMenu, type TreeMoves } from './doc-tree';
import type { RowMenuItem } from './row-menu';
import { editedAgo } from '../lib/files';
import { clampPanelWidth, isPanelWide, panelWideWidth } from '../lib/panel-width';
import { ArtifactViewer, FILES_CHANGED_EVENT } from './artifact-viewer';
import { PushDialog } from './bridge-dialogs';
import { ChevronLeftIcon, CollapseIcon, ExpandIcon, FileIcon, XIcon } from './icons';

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
export function useChatArtifacts(
  chatId: string,
  options: { linked?: LinkedArena | null; initialFile?: string | null } = {},
) {
  const [items, setItems] = useState<Artifact[] | null>(null);
  // `?file=` (a copy just made, a handoff): open the panel on that file.
  const [open, setOpen] = useState(Boolean(options.initialFile));
  const [selected, setSelected] = useState<string | null>(options.initialFile ?? null);
  const linked = options.linked ?? null;
  const initialFile = options.initialFile ?? null;
  useEffect(() => {
    if (!initialFile) return;
    setSelected(initialFile);
    setOpen(true);
  }, [initialFile]);
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
    // SWA's state file is not a document people open.
    items: (items ?? []).filter((a) => docPlace(a.name)),
    open,
    selected,
    setOpen,
    show,
    notify,
    reload: load,
    chatId,
    linked,
  };
}

export type ChatArtifacts = ReturnType<typeof useChatArtifacts>;

/** The small "Files (n)" tab on the chat's right edge while the panel is closed. */
export function ChatArtifactsToggle({ state }: { state: ChatArtifacts }) {
  if (state.open || (state.items.length === 0 && !state.linked)) return null;
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

/** "Architecture › Decisions › ADR-0003-x.md": where the open document sits. */
function placeLabel(name: string): string {
  const place = docPlace(name);
  return place ? [...place.folders, place.file].join(' › ') : name;
}

export function ChatArtifactsPanel({ state }: { state: ChatArtifacts }) {
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const narrow = useRef(DEFAULT_WIDTH);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [push, setPush] = useState<{ artifact: Artifact; versionNo: number } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const fileMoves = useFileMoves(state.items, state.chatId, () => void state.reload());
  // An arena file dropped here is copied into this chat (asking first when this chat is not
  // linked to that arena).
  const drop = useDropTarget(['arena'], (payload) => {
    if (payload.kind === 'arena') {
      requestCopyToChat({
        projectId: payload.project_id,
        artifactIds: [payload.artifact_id],
        chatId: state.chatId,
      });
    }
  });

  useEffect(() => setWidth(readWidth()), []);

  if (!state.open || (state.items.length === 0 && !state.linked)) return null;
  const linked = state.linked;

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
      {...drop.props}
      className={`fixed inset-0 z-30 flex flex-col bg-panel md:relative md:inset-auto md:z-auto md:w-[var(--chat-panel-w)] md:shrink-0 md:border-l md:border-line ${drop.over ? DROP_OVER : ''}`}
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
          {current ? placeLabel(current.name) : ''}
        </span>
        {linked && !current && (
          <button
            type="button"
            className="btn h-8 px-2.5 text-[13px]"
            aria-expanded={adding}
            onClick={() => setAdding((v) => !v)}
          >
            Add from arena
          </button>
        )}
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
            dragPayload={{
              kind: 'private',
              artifact_id: current.id,
              chat_id: current.private_session_id,
            }}
            onPush={(artifact, versionNo) => setPush({ artifact, versionNo })}
            onChanged={() => void state.reload()}
            onDeleted={() => {
              state.show(null);
              void state.reload();
            }}
          />
        ) : adding && linked ? (
          <AddFromArena
            arena={linked}
            chatId={state.chatId}
            onDone={(id) => {
              setAdding(false);
              void state.reload().then(() => state.show(id));
            }}
          />
        ) : state.items.length === 0 ? (
          <p className="px-4 py-6 text-[14px] text-muted">
            No files yet. Add one from {linked?.name ?? 'the arena'}, or drag an arena file here.
          </p>
        ) : (
          <FileList
            items={state.items}
            onOpen={(id) => state.show(id)}
            moves={fileMoves.moves}
            menu={fileMoves.menuItems}
            folderMenu={fileMoves.folderMenu}
          />
        )}
      </div>
      {fileMoves.dialogs}
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

function FileList({
  items,
  onOpen,
  moves,
  menu,
  folderMenu,
}: {
  items: readonly Artifact[];
  onOpen: (id: string) => void;
  moves: TreeMoves;
  menu: (a: Artifact) => RowMenuItem[];
  folderMenu: FolderMenu;
}) {
  return (
    <div className="py-2">
      <DocTree
        items={items}
        moves={moves}
        folderMenu={folderMenu}
        row={(a, file) => {
          const status = artifactStatus(a);
          return (
            <div className="group flex items-center pr-2">
              <button
                type="button"
                onClick={() => onOpen(a.id)}
                className="nav flex w-full items-center gap-2.5 px-4 py-2 text-left"
              >
                <FileIcon size={16} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-text">{file}</span>
                  <span className="block text-[12px] text-faint">
                    v{a.head_version_no} · {editedAgo(a.updated_at)}
                  </span>
                </span>
                <span className={`chip ${status.tone} px-1.5 py-0.5 text-[12px]`}>
                  {status.label}
                </span>
              </button>
              <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                <RowMenu label={`Actions for ${file}`} items={menu(a)} />
              </span>
            </div>
          );
        }}
      />
    </div>
  );
}

/**
 * "Add from arena" (ADR-041): the linked arena's files, approved ones first, to copy into this
 * chat. A copy is yours; pushing it back adds a version to the same arena file.
 */
function AddFromArena({
  arena,
  chatId,
  onDone,
}: {
  arena: LinkedArena;
  chatId: string;
  onDone: (copyId: string | null) => void;
}) {
  const [files, setFiles] = useState<Artifact[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<ArtifactList>(`/projects/${encodeURIComponent(arena.id)}/artifacts`, controller.signal)
      .then((list) =>
        setFiles(
          [...list.items]
            .filter((a) => a.kind !== 'progress' && a.kind !== 'stage_summary')
            .sort((x, y) => Number(isApproved(y)) - Number(isApproved(x))),
        ),
      )
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not load the arena’s files.');
      });
    return () => controller.abort();
  }, [arena.id]);

  const copy = async (a: Artifact) => {
    setBusy(a.id);
    setError(null);
    try {
      const result = await copyArenaFiles(arena.id, [a.id], chatId);
      announce(`Copied ${a.name} from ${arena.name}.`);
      onDone(result.copies[0]?.artifact_id ?? null);
    } catch {
      setError('Could not copy. Please try again.');
      setBusy(null);
    }
  };

  return (
    <div className="py-2">
      <p className="px-4 pb-2 text-[13px] text-muted">
        Files in {arena.name}. A copy is yours; Push to Arena adds your changes to the same file.
      </p>
      {error && (
        <p role="alert" className="px-4 py-1 text-[13px] text-bad">
          {error}
        </p>
      )}
      {!files && !error && <p className="px-4 text-[13px] text-faint">Loading…</p>}
      {files && files.length === 0 && (
        <p className="px-4 text-[13px] text-faint">This arena has no files yet.</p>
      )}
      <ul>
        {files?.map((a) => {
          const status = artifactStatus(a);
          return (
            <li key={a.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void copy(a)}
                className="nav flex w-full items-center gap-2.5 px-4 py-2 text-left"
              >
                <FileIcon size={16} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-text">{a.name}</span>
                <span className="text-[12px] text-faint">
                  {busy === a.id ? 'Copying…' : `v${a.approved_version_no ?? a.head_version_no}`}
                </span>
                <span className={`chip ${status.tone} px-1.5 py-0.5 text-[12px]`}>
                  {status.label}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
