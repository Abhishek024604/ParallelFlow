'use client';

import type { ChatMessagePage, PrivateChat, PrivateProject } from '@saras/contracts';
import { useRouter } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { apiSend, ProblemError } from '../lib/api-browser';
import { ChatRoom } from './arena-room';
import { LockIcon } from './icons';
import { RowMenu } from './row-menu';
import { SoonTip } from './soon';

// A private chat (screen 02, build step 5): title with rename / delete, the "Not linked to an arena"
// chip, which project it is filed in, and the stream with the AI (ChatRoom). The bridge (Bring
// context, Push to Arena, the right panel) is step 6.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

export function PrivateChatHeader({
  chat,
  projects,
}: {
  chat: PrivateChat;
  projects: PrivateProject[];
}) {
  const router = useRouter();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const remove = async () => {
    if (!window.confirm('Delete this chat? Its messages are deleted too.')) return;
    if (await run(() => apiSend('DELETE', `/private/sessions/${chat.id}`))) {
      router.push('/private');
      router.refresh();
    }
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
            Not linked to an arena
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
        <span className="w-auto">
          <SoonTip side="bottom">
            <button
              type="button"
              aria-disabled="true"
              className="btn h-10 cursor-not-allowed px-4 opacity-55"
            >
              Bring context
            </button>
          </SoonTip>
        </span>
        <span className="w-auto">
          <SoonTip side="bottom">
            <button
              type="button"
              aria-disabled="true"
              className="btn pri h-10 cursor-not-allowed px-4 opacity-55"
            >
              Push to Arena
            </button>
          </SoonTip>
        </span>
      </div>
    </header>
  );
}

export function PrivateChatRoom({
  chatId,
  initial,
  viewerId,
  initialTurnId,
}: {
  chatId: string;
  initial: ChatMessagePage;
  viewerId: string;
  initialTurnId: string | null;
}) {
  const router = useRouter();
  const base = `/private/sessions/${encodeURIComponent(chatId)}`;
  // `?turn=` is only for the first render: drop it so a reload does not replay that turn's status.
  useEffect(() => {
    if (initialTurnId) router.replace(`/private/${chatId}`, { scroll: false });
  }, [chatId, initialTurnId, router]);
  return (
    <ChatRoom
      messagesPath={`${base}/messages`}
      eventsPath={(turnId) => `/v1${base}/turns/${encodeURIComponent(turnId)}/events`}
      initial={initial}
      canPost
      viewerId={viewerId}
      mentionNames={[]}
      regionLabel="Chat messages"
      emptyText="No messages yet. Ask your AI anything."
      composerLabel="Message your AI · only you can see this"
      initialTurnId={initialTurnId}
      // The sidebar shows the newest chat first and names a chat by its first message.
      onPosted={() => router.refresh()}
    />
  );
}
