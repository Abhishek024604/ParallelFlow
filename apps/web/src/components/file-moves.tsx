'use client';

import {
  type Artifact,
  baseName,
  folderOf,
  nameInFolder,
  normalizeFolder,
  type PrivateChatList,
  uuidv7,
} from '@parallelflow/contracts';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { apiGet, apiPost, apiSend, ProblemError } from '../lib/api-browser';
import { docTree, type DocFolder } from '../lib/chat-files';
import { announce, requestPush, requestPushFolder } from '../lib/file-drag';
import { FILES_CHANGED_EVENT } from './artifact-viewer';
import {
  findFolder,
  type FolderMenu,
  hasLiteralFolder,
  isMovableFolder,
  type TreeMoves,
} from './doc-tree';
import type { RowMenuItem } from './row-menu';

// Moving private files (ADR-041), for the chat's files panel and My files: drag and drop (DocTree
// `moves`) and the same moves from a file's ⋯ menu ("Move to folder…", "Move to chat…", "Push to
// arena"). A file keeps its id, versions and history; a folder move renames every file under it in
// one request. Results are announced for screen readers.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

const placeName = (folder: string) => (folder ? `“${folder}”` : 'the top level');

function allFolders(root: DocFolder): string[] {
  const out: string[] = [];
  const walk = (f: DocFolder) => {
    for (const child of f.folders) {
      out.push(child.path);
      walk(child);
    }
  };
  walk(root);
  return out;
}

export function useFileMoves(
  items: readonly Artifact[],
  chatId: string | null,
  reload: () => void,
) {
  const [dialog, setDialog] = useState<{ kind: 'folder' | 'chat'; artifact: Artifact } | null>(
    null,
  );
  const changed = () => {
    window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
    reload();
  };

  const moveToFolder = async (artifactId: string, folder: string) => {
    const artifact = items.find((a) => a.id === artifactId);
    if (!artifact) return;
    if (!hasLiteralFolder(artifact.name)) {
      announce('Architecture files keep their standard names. You can move them to another chat.');
      return;
    }
    const name = nameInFolder(artifact.name, folder);
    if (name === artifact.name) return;
    try {
      await apiSend('PATCH', `/artifacts/${encodeURIComponent(artifactId)}`, { name });
      announce(`Moved ${baseName(name)} to ${placeName(normalizeFolder(folder))}.`);
      changed();
    } catch (err) {
      announce(errorText(err));
    }
  };

  const moveFolder = async (from: string, toParent: string) => {
    const to = toParent ? `${toParent} › ${baseName(from)}` : baseName(from);
    if (to === from) return;
    if (findFolder(items, from) && !isMovableFolder(items, from)) {
      announce('Architecture folders keep their standard names. You can push them to an arena.');
      return;
    }
    try {
      const result = await apiPost<{ renamed: number }>(
        '/artifacts/folders:rename',
        { from, to, ...(chatId && { private_session_id: chatId }) },
        { idempotencyKey: uuidv7() },
      );
      announce(
        `Moved folder ${baseName(from)} (${result.renamed} files) to ${placeName(toParent)}.`,
      );
      changed();
    } catch (err) {
      announce(errorText(err));
    }
  };

  const moves: TreeMoves = {
    chatId,
    onFileToFolder: (id, folder) => void moveToFolder(id, folder),
    onFolderToFolder: (from, to) => void moveFolder(from, to),
  };

  const menuItems = (artifact: Artifact): RowMenuItem[] => [
    ...(hasLiteralFolder(artifact.name)
      ? [{ label: 'Move to folder…', onSelect: () => setDialog({ kind: 'folder', artifact }) }]
      : []),
    { label: 'Move to chat…', onSelect: () => setDialog({ kind: 'chat', artifact }) },
    { label: 'Push to arena', onSelect: () => requestPush({ artifactId: artifact.id }) },
  ];

  // A chat's folder goes to an arena in one push (My files spans chats, so it has no such item).
  const folderMenu: FolderMenu = (folder) =>
    chatId
      ? [
          {
            label: 'Push folder to Arena',
            onSelect: () => requestPushFolder({ chatId, path: folder.path }),
          },
        ]
      : [];

  const dialogs = dialog && (
    <MoveDialog
      kind={dialog.kind}
      artifact={dialog.artifact}
      folders={allFolders(docTree(items))}
      onClose={() => setDialog(null)}
      onFolder={(folder) => moveToFolder(dialog.artifact.id, folder)}
      onChat={async (target, title) => {
        await apiSend('PATCH', `/artifacts/${encodeURIComponent(dialog.artifact.id)}`, {
          private_session_id: target,
        });
        announce(`Moved ${baseName(dialog.artifact.name)} to ${title}.`);
        changed();
      }}
    />
  );

  return { moves, menuItems, folderMenu, dialogs, moveToChat: moveFileToChat };
}

/** Moves a private file to another chat (a drop on a chat in the sidebar). */
export async function moveFileToChat(artifactId: string, chatId: string, title: string) {
  try {
    await apiSend('PATCH', `/artifacts/${encodeURIComponent(artifactId)}`, {
      private_session_id: chatId,
    });
    announce(`Moved the file to ${title}.`);
    window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
  } catch (err) {
    announce(errorText(err));
  }
}

const NEW_FOLDER = '\u0000new';

function MoveDialog({
  kind,
  artifact,
  folders,
  onClose,
  onFolder,
  onChat,
}: {
  kind: 'folder' | 'chat';
  artifact: Artifact;
  folders: string[];
  onClose: () => void;
  onFolder: (folder: string) => Promise<void>;
  onChat: (chatId: string, title: string) => Promise<void>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const current = folderOf(artifact.name);
  const [choice, setChoice] = useState(kind === 'folder' ? current : '');
  const [fresh, setFresh] = useState('');
  const [chats, setChats] = useState<{ id: string; title: string; linked: string | null }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  useEffect(() => {
    if (kind !== 'chat') return;
    apiGet<PrivateChatList>('/private/sessions?limit=200').then(
      (list) =>
        setChats(
          list.items
            .filter((c) => c.id !== artifact.private_session_id)
            .map((c) => ({
              id: c.id,
              title: c.title ?? 'New chat',
              linked: c.bound_project?.name ?? null,
            })),
        ),
      (err: unknown) => setError(errorText(err)),
    );
  }, [kind, artifact.private_session_id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'folder') {
        await onFolder(choice === NEW_FOLDER ? fresh : choice);
      } else {
        const chat = chats.find((c) => c.id === choice);
        if (!chat) throw new ProblemError(400, 'VALIDATION_FAILED', 'Pick a chat.');
        await onChat(chat.id, chat.title);
      }
      ref.current?.close();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className="card m-auto w-[min(440px,calc(100vw-32px))] p-0 shadow-pop backdrop:bg-scrim"
    >
      <form onSubmit={(e) => void submit(e)} className="p-6">
        <h2 id={titleId} className="text-[18px] font-semibold text-text">
          {kind === 'folder' ? 'Move to folder' : 'Move to chat'}
        </h2>
        <p className="mt-1 truncate text-[13px] text-muted">{baseName(artifact.name)}</p>
        {kind === 'folder' ? (
          <>
            <select
              aria-label="Folder"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="inp mt-4 h-10 w-full px-2.5"
            >
              <option value="">Top level</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
              <option value={NEW_FOLDER}>New folder…</option>
            </select>
            {choice === NEW_FOLDER && (
              <input
                aria-label="New folder name"
                value={fresh}
                onChange={(e) => setFresh(e.target.value)}
                placeholder="specs › checkout"
                maxLength={100}
                autoFocus
                className="inp mt-2 w-full"
              />
            )}
          </>
        ) : (
          <>
            <select
              aria-label="Chat"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="inp mt-4 h-10 w-full px-2.5"
            >
              <option value="">Choose a chat</option>
              {chats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                  {c.linked ? ` · Linked to arena · ${c.linked}` : ''}
                </option>
              ))}
            </select>
            {artifact.upstream && (
              <p className="mt-1.5 text-[12px] text-faint">
                A copy from {artifact.upstream.arena_name ?? 'an arena'} can only move to a chat
                linked to that arena, or to one that is not linked.
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
            {error}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            className="btn h-10 px-4"
            onClick={() => ref.current?.close()}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="btn pri h-10 px-4"
            disabled={
              busy ||
              (kind === 'chat' && !choice) ||
              (kind === 'folder' && choice === NEW_FOLDER && !fresh.trim())
            }
          >
            {busy ? 'Moving…' : 'Move'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
