'use client';

import type {
  ArenaList,
  ChatMessagePage,
  LinkedArena,
  PrivateChat,
  PrivateProject,
} from '@parallelflow/contracts';
import { aiCommandsFor } from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiGet, apiSend, ProblemError } from '../lib/api-browser';
import { retract } from '../lib/optimistic';
import { ConfirmDialog } from './dialog';
import { ChatRoom } from './arena-room';
import type { ComposerCommand } from './command-menu';
import { ArenaPicker, bringContext } from './bridge-dialogs';
import { ChatArtifactsPanel, ChatArtifactsToggle, useChatArtifacts } from './chat-artifacts';
import { LockIcon } from './icons';
import { RowMenu } from './row-menu';

const NO_EXTENSIONS: readonly string[] = [];

/**
 * The private composer's "/" menu: the AI commands (with your installed extensions' /pm, /swa),
 * then /arena (handled here, never sent).
 */
const privateCommands = (installed: readonly string[]): ComposerCommand[] => [
  ...aiCommandsFor('private', installed),
  {
    name: 'arena',
    description: "Bring an arena's context into this chat",
    argumentHint: '<arena name>',
  },
];

// A private chat (screen 02): title with rename / delete, the link chip ("Linked to arena · <name>"
// or "Not linked to an arena"), which project it is filed in, and the stream with the AI (ChatRoom).
// The bridge (step 6): "Bring context" (an arena picker, or typing "/arena <name>") links the chat
// to one arena for good. The documents the AI saves here show in the chat's files panel on the right
// (chat-artifacts.tsx; also in My files); its viewer's "Push to Arena" copies one file into an
// arena. Push is per file, never per chat.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

export function PrivateChatHeader({
  chat,
  projects,
  autoBring = false,
}: {
  chat: PrivateChat;
  projects: PrivateProject[];
  /** Open the arena picker right away (the Private home's "Bring context" suggestion). */
  autoBring?: boolean;
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(autoBring);
  const linked = chat.bound_project;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      return true;
    } catch (err) {
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const rename = async (event: FormEvent) => {
    event.preventDefault();
    const value = title.trim();
    if (!value) return;
    if (await run(() => apiSend('PATCH', `/private/sessions/${chat.id}`, { title: value }))) {
      setRenaming(false);
      router.refresh();
    }
  };

  const move = async (projectId: string) => {
    if (
      await run(() =>
        apiSend('PUT', `/private/sessions/${chat.id}/project`, {
          private_project_id: projectId || null,
        }),
      )
    ) {
      router.refresh();
    }
  };

  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = () => setConfirmDelete(true);

  const bring = async () => {
    if (!linked) {
      setPicking(true);
      return;
    }
    if (await run(() => bringContext(chat.id, linked.id))) router.refresh();
  };

  return (
    <header className="flex items-start gap-4 border-b border-line px-6 py-4">
      <div className="min-w-0 flex-1">
        {renaming ? (
          <form onSubmit={(e) => void rename(e)} className="flex items-center gap-2">
            <input
              aria-label="Chat name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setTitle(chat.title ?? '');
                  setRenaming(false);
                }
              }}
              maxLength={120}
              autoFocus
              autoComplete="off"
              disabled={busy}
              className="inp h-9 w-full max-w-[420px] px-2.5 text-[16px] font-semibold"
            />
            <button type="submit" className="btn pri h-9 px-3 text-[14px]" disabled={busy}>
              Save
            </button>
            <button
              type="button"
              className="btn ghost h-9 px-3 text-[14px]"
              onClick={() => {
                setTitle(chat.title ?? '');
                setRenaming(false);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="flex items-center gap-1">
            <h1 className="truncate text-[18px] font-bold text-text">{chat.title ?? 'New chat'}</h1>
            <RowMenu
              label="Chat options"
              align="left"
              items={[
                { label: 'Rename', onSelect: () => setRenaming(true) },
                { label: 'Delete', danger: true, onSelect: () => void remove() },
              ]}
            />
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-faint">
          <span className="chip inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px]">
            <LockIcon size={12} />
            {linked ? `Linked to arena · ${linked.name}` : 'Not linked to an arena'}
          </span>
          <span>Private · only you</span>
          <label className="ml-2 inline-flex items-center gap-1.5">
            <span>Project</span>
            <select
              value={chat.private_project_id ?? ''}
              onChange={(e) => void move(e.target.value)}
              disabled={busy}
              className="inp h-7 px-1.5 text-[13px] text-text"
            >
              <option value="">None (Recent chats)</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {error && (
          <p role="alert" className="mt-1 text-[12px] text-bad">
            {error}
          </p>
        )}
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="btn h-10 px-4"
          disabled={busy}
          onClick={() => void bring()}
          title={linked ? `Refresh context from ${linked.name}` : 'Bring context from an arena'}
        >
          {linked ? 'Refresh context' : 'Bring context'}
        </button>
      </div>
      {picking && (
        <ArenaPicker
          chatId={chat.id}
          onClose={() => {
            setPicking(false);
            if (autoBring) router.replace(`/private/${chat.id}`, { scroll: false });
          }}
          onLinked={() => router.refresh()}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this chat?"
          body="The chat and its messages are deleted. Files you pushed to an arena stay there."
          confirmLabel="Delete chat"
          danger
          onConfirm={async () => {
            await apiSend('DELETE', `/private/sessions/${chat.id}`);
            retract('chats', chat.id);
            router.push('/private');
            router.refresh();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </header>
  );
}

export function PrivateChatRoom({
  chatId,
  initial,
  viewerId,
  initialTurnId,
  extensions = NO_EXTENSIONS,
  linked = null,
  initialFile = null,
}: {
  /** The arena this chat is linked to: its files panel offers "Add from arena". */
  linked?: LinkedArena | null;
  /** A file to open in the files panel at once (`?file=`, after a copy). */
  initialFile?: string | null;
  chatId: string;
  initial: ChatMessagePage;
  viewerId: string;
  initialTurnId: string | null;
  /** Your installed extensions (their commands join the "/" menu). */
  extensions?: readonly string[];
}) {
  const router = useRouter();
  const commands = useMemo(() => privateCommands(extensions), [extensions]);
  const files = useChatArtifacts(chatId, { linked, initialFile });
  const base = `/private/sessions/${encodeURIComponent(chatId)}`;
  // "/arena <name>": bring context from that arena (links this chat to it for good).
  const onCommand = useCallback(
    async (text: string) => {
      const match = /^\/arena(?:\s+(.+))?$/i.exec(text);
      if (!match) return false;
      const name = (match[1] ?? '').trim().toLowerCase();
      if (!name) {
        throw new ProblemError(400, 'VALIDATION_FAILED', 'Type /arena and the arena’s name.');
      }
      const { items } = await apiGet<ArenaList>('/arenas');
      const exact = items.filter(
        (a) => a.name.toLowerCase() === name || a.key.toLowerCase() === name,
      );
      const loose = items.filter((a) => a.name.toLowerCase().includes(name));
      const arena = exact[0] ?? (loose.length === 1 ? loose[0] : undefined);
      if (!arena) {
        throw new ProblemError(
          400,
          'VALIDATION_FAILED',
          loose.length > 1
            ? 'More than one arena matches. Type its full name.'
            : 'No arena by that name. Check the name, or use Bring context.',
        );
      }
      await bringContext(chatId, arena.id);
      router.refresh();
      return true;
    },
    [chatId, router],
  );
  // `?turn=` is only for the first render: drop it so a reload does not replay that turn's status.
  useEffect(() => {
    if (initialTurnId) router.replace(`/private/${chatId}`, { scroll: false });
  }, [chatId, initialTurnId, router]);
  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatRoom
          messagesPath={`${base}/messages`}
          eventsPath={(turnId) => `/v1${base}/turns/${encodeURIComponent(turnId)}/events`}
          initial={initial}
          canPost
          viewerId={viewerId}
          mentionNames={[]}
          regionLabel="Chat messages"
          emptyText="No messages yet. Ask your AI anything."
          composerLabel="Message your AI · only you can see this · type / for commands"
          initialTurnId={initialTurnId}
          uploadPath="/private/files"
          fileUrl={(fileId) => `/v1/private/files/${encodeURIComponent(fileId)}`}
          // A document card opens in this chat's files panel (like Claude's artifacts).
          onOpenArtifact={files.show}
          onArtifacts={files.notify}
          onCommand={onCommand}
          commands={commands}
          // The sidebar shows the newest chat first and names a chat by its first message.
          onPosted={() => router.refresh()}
        />
        <ChatArtifactsToggle state={files} />
      </div>
      <ChatArtifactsPanel state={files} />
    </div>
  );
}
