'use client';

import {
  AI_NOT_CONNECTED_CODES,
  type ArenaMessagePage,
  type ArenaTurnStreamEvent,
  type ChatMessage,
  type ChatMessagePage,
  type FileRef,
  formatBytes,
  IMAGE_TYPES,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_BODY_MAX_CHARS,
  MESSAGE_PAGE_MAX,
  type SendMessageResult,
  uuidv7,
} from '@saras/contracts';
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { apiGet, apiPost, apiUpload, ProblemError } from '../lib/api-browser';
import { dayKey, dayLabel, mergeMessages, timeLabel } from '../lib/chat';
import { uploadTypeOf } from '../lib/files';
import { markArenaRead } from '../lib/notifications';
import {
  ArenaArtifactDialog,
  OPEN_ARTIFACT_EVENT,
  type OpenArtifactRequest,
} from './artifact-viewer';
import { ArrowUpIcon, FileIcon, InfoIcon, PlusIcon, XIcon } from './icons';
import { GateCard } from './loop';

// The arena stream and composer (screen 04, build step 3). The server page renders the latest page;
// from then on this polls GET …/arena/messages?after=<latest_cursor> every 2 s while the tab is
// visible (paused when hidden, backing off on errors) and merges by id, so a message posted here and
// returned again by the next poll shows once. Bodies are plain text: React escapes them and
// `whitespace-pre-wrap` keeps line breaks. Nothing here logs message content.
//
// @AI (build step 4): a post that queued an AI turn opens an EventSource on
// /v1/projects/{id}/arena/turns/{turn}/events (a streaming route handler, not the buffering /v1
// rewrite) and shows the live text in a Dusk bubble until the AI's message arrives by polling.
//
// ChatRoom is the stream itself; ArenaRoom and the private chat (step 5) pass their own API paths
// and wording.
//
// Files (step 6): the composer's + uploads to the arena or your Private space (raw body, checked
// by type and bytes on the API) and sends the file ids with the message. Attachments show as chips;
// images as thumbnails from the safe download route. A Push to Arena card ("event") opens the
// artifact viewer.

const POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** Within this many px of the bottom counts as "at the bottom": new messages scroll into view. */
const STICK_PX = 80;

const messagesPath = (arenaId: string) => `/projects/${encodeURIComponent(arenaId)}/arena/messages`;
const turnEventsPath = (arenaId: string, turnId: string) =>
  `/v1/projects/${encodeURIComponent(arenaId)}/arena/turns/${encodeURIComponent(turnId)}/events`;

/** A message being sent (optimistic), or one that failed and can be retried. */
interface PendingMessage {
  tempId: string;
  /** Idempotency-Key, kept for Retry. */
  key: string;
  body: string;
  attachments: readonly FileRef[];
  error: string | null;
}

function PendingBubble({
  item,
  onRetry,
  onDiscard,
}: {
  item: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="mt-4 flex gap-3" aria-busy={item.error ? undefined : true}>
      <span aria-hidden="true" className="h-8 w-8 shrink-0" />
      <div className="min-w-0 flex-1">
        <p
          className={`whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text ${
            item.error ? '' : 'opacity-60'
          }`}
        >
          {item.body}
        </p>
        {item.attachments.length > 0 && (
          <p className="mt-1 text-[12px] text-faint">
            {item.attachments.map((f) => f.name).join(', ')}
          </p>
        )}
        {item.error ? (
          <p role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted">
            Not sent. {item.error}
            <button type="button" className="btn ghost h-7 px-2 text-[12px]" onClick={onRetry}>
              Retry
            </button>
            <button type="button" className="btn ghost h-7 px-2 text-[12px]" onClick={onDiscard}>
              Discard
            </button>
          </p>
        ) : (
          <p className="mt-1 text-[12px] text-faint">Sending…</p>
        )}
      </div>
    </div>
  );
}

interface LiveTurn {
  id: string;
  text: string;
  state: 'running' | 'done' | 'failed';
  failureCode: string | null;
  messageId: string | null;
}

function failureText(code: string | null): string {
  return code && AI_NOT_CONNECTED_CODES.includes(code)
    ? "AI isn't connected yet"
    : "AI couldn't answer";
}

export function ArenaRoom({
  arenaId,
  arenaKey,
  initial,
  canPost,
  viewerId,
  memberNames,
}: {
  arenaId: string;
  arenaKey: string;
  initial: ArenaMessagePage;
  canPost: boolean;
  viewerId: string;
  memberNames: readonly string[];
}) {
  const [openArtifact, setOpenArtifact] = useState<OpenArtifactRequest | null>(null);
  const openById = useCallback((id: string) => setOpenArtifact({ id }), []);
  // An Inbox link (?artifact=<id>) opens that document.
  const linkedArtifact = useSearchParams().get('artifact');
  useEffect(() => {
    if (linkedArtifact && /^[0-9a-f-]{36}$/i.test(linkedArtifact)) {
      setOpenArtifact({ id: linkedArtifact });
    }
  }, [linkedArtifact]);
  // The Approved tab and the sidebar's Files (other components) open the same viewer.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<OpenArtifactRequest>).detail;
      if (detail && typeof detail.id === 'string') setOpenArtifact(detail);
    };
    window.addEventListener(OPEN_ARTIFACT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_ARTIFACT_EVENT, onOpen);
  }, []);
  // Opening the arena, and new messages from others while you look at it, mark it read (the
  // sidebar badge and the Inbox's "new messages" item clear).
  useEffect(() => {
    void markArenaRead(arenaId).catch(() => undefined);
  }, [arenaId]);
  const readTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onIncoming = useCallback(() => {
    clearTimeout(readTimer.current);
    readTimer.current = setTimeout(() => {
      if (document.visibilityState === 'visible') {
        void markArenaRead(arenaId).catch(() => undefined);
      }
    }, 1_000);
  }, [arenaId]);
  useEffect(() => () => clearTimeout(readTimer.current), []);
  const project = encodeURIComponent(arenaId);
  return (
    <>
      <ChatRoom
        onIncoming={onIncoming}
        messagesPath={messagesPath(arenaId)}
        uploadPath={`/projects/${project}/files`}
        fileUrl={(fileId) => `/v1/projects/${project}/files/${encodeURIComponent(fileId)}`}
        onOpenArtifact={openById}
        renderGate={(message) => <GateCard message={message} />}
        eventsPath={(turnId) => turnEventsPath(arenaId, turnId)}
        initial={initial}
        canPost={canPost}
        viewerId={viewerId}
        mentionNames={memberNames}
        regionLabel="Arena messages"
        emptyText="No messages yet. Say hello to your teammates."
        composerLabel={`Message the Arena · everyone in ${arenaKey} can see this`}
      />
      {openArtifact && (
        <ArenaArtifactDialog
          key={`${openArtifact.id}:${openArtifact.versionNo ?? ''}`}
          projectId={arenaId}
          artifactId={openArtifact.id}
          {...(openArtifact.versionNo && { versionNo: openArtifact.versionNo })}
          onClose={() => setOpenArtifact(null)}
        />
      )}
    </>
  );
}

export interface ChatRoomProps {
  /** API path of the stream's messages (GET page / poll, POST). */
  messagesPath: string;
  /** Streaming route of an AI turn's live text. Derived from the same id as messagesPath. */
  eventsPath: (turnId: string) => string;
  initial: ChatMessagePage;
  canPost: boolean;
  viewerId: string;
  mentionNames: readonly string[];
  regionLabel: string;
  emptyText: string;
  composerLabel: string;
  /** An AI turn already running when the page opened (a chat started from the private home). */
  initialTurnId?: string | null;
  /** After a post is stored (e.g. to refresh the private sidebar). */
  onPosted?: () => void;
  /** Where the composer's + uploads (POST, raw body). No + when unset. */
  uploadPath?: string;
  /** Browser URL of an attachment (the safe download route). */
  fileUrl?: (fileId: string) => string;
  /** A typed command (e.g. "/arena Checkout"): true when handled, so it is not sent. */
  onCommand?: (text: string) => Promise<boolean>;
  /** "View" on a Push to Arena card, and the file cards under an AI reply. */
  onOpenArtifact?: (artifactId: string) => void;
  /** A page for a document (used instead of onOpenArtifact for the AI's file cards). */
  artifactHref?: (artifactId: string) => string;
  /** A stage gate card (arena only, build step 7). */
  renderGate?: (message: ChatMessage) => ReactNode;
  /** A poll brought messages from someone else. */
  onIncoming?: () => void;
}

export function ChatRoom({
  messagesPath: streamPath,
  eventsPath,
  initial,
  canPost,
  viewerId,
  mentionNames,
  regionLabel,
  emptyText,
  composerLabel,
  initialTurnId,
  onPosted: afterPost,
  uploadPath,
  fileUrl,
  onCommand,
  onOpenArtifact,
  artifactHref,
  renderGate,
  onIncoming,
}: ChatRoomProps) {
  const [messages, setMessages] = useState<readonly ChatMessage[]>(initial.items);
  const [pending, setPending] = useState<readonly PendingMessage[]>([]);
  const [olderCursor, setOlderCursor] = useState(initial.next_cursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [pollState, setPollState] = useState<'ok' | 'retrying' | 'stopped'>('ok');
  const [announcement, setAnnouncement] = useState('');
  // Times and "Today" depend on the browser's time zone, so the stream renders after mount.
  const [mounted, setMounted] = useState(false);
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(
    initialTurnId
      ? { id: initialTurnId, text: '', state: 'running', failureCode: null, messageId: null }
      : null,
  );
  const eventsPathRef = useRef(eventsPath);
  eventsPathRef.current = eventsPath;
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  /** Polls right away (set by the polling effect). */
  const pollNow = useRef<() => void>(() => undefined);

  const latestCursor = useRef(initial.latest_cursor);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /** Distance from the bottom to restore after older messages are prepended. */
  const restoreFromBottom = useRef<number | null>(null);

  useEffect(() => setMounted(true), []);

  const addMessages = useCallback(
    (incoming: readonly ChatMessage[], announce: boolean) => {
      if (incoming.length === 0) return;
      setMessages((current) => mergeMessages(current, incoming));
      if (announce) {
        const fromOthers = incoming.filter((m) => m.author.id !== viewerId);
        const last = fromOthers.at(-1);
        if (last) {
          setAnnouncement(`New message from ${last.author.display_name}`);
          onIncoming?.();
        }
      }
    },
    [viewerId, onIncoming],
  );

  // Polling.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = POLL_MS;
    let inFlight: AbortController | null = null;
    let stopped = false;
    const visible = () => document.visibilityState === 'visible';

    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && visible()) timer = setTimeout(() => void tick(), delay);
    };

    const tick = async () => {
      if (stopped || inFlight || !visible()) return;
      const controller = new AbortController();
      inFlight = controller;
      try {
        const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_MAX) });
        if (latestCursor.current) query.set('after', latestCursor.current);
        const page = await apiGet<ChatMessagePage>(
          `${streamPath}?${query.toString()}`,
          controller.signal,
        );
        if (page.latest_cursor) latestCursor.current = page.latest_cursor;
        addMessages(page.items, true);
        delay = POLL_MS;
        setPollState('ok');
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err instanceof ProblemError && [401, 403, 404].includes(err.status)) {
          // Signed out, or no longer a member: retrying will not help.
          stopped = true;
          setPollState('stopped');
          return;
        }
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        setPollState('retrying');
      } finally {
        if (inFlight === controller) inFlight = null;
      }
      schedule();
    };

    pollNow.current = () => {
      clearTimeout(timer);
      void tick();
    };
    const onVisibility = () => {
      if (visible()) void tick();
      else clearTimeout(timer);
    };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      inFlight?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [streamPath, addMessages]);

  // Live text of the AI turn this viewer started. Polling still delivers the final message.
  const liveTurnId = liveTurn?.id;
  useEffect(() => {
    if (!liveTurnId) return;
    const source = new EventSource(eventsPathRef.current(liveTurnId));
    let errors = 0;
    source.onmessage = (frame: MessageEvent<string>) => {
      let event: ArenaTurnStreamEvent;
      try {
        event = JSON.parse(frame.data) as ArenaTurnStreamEvent;
      } catch {
        return;
      }
      if (event.type === 'delta') {
        const text = event.text;
        setLiveTurn((t) => (t?.id === liveTurnId ? { ...t, text: t.text + text } : t));
        return;
      }
      source.close();
      const failed = event.status === 'failed' || event.status === 'cancelled';
      setLiveTurn((t) =>
        t?.id === liveTurnId
          ? {
              ...t,
              state: failed ? 'failed' : 'done',
              failureCode: event.failure_code,
              messageId: event.message_id,
            }
          : t,
      );
      pollNow.current();
    };
    source.onerror = () => {
      // The browser reconnects by itself; give up after a few tries and let polling catch up.
      errors += 1;
      if (errors >= 3) {
        source.close();
        setLiveTurn((t) =>
          t?.id === liveTurnId && t.state === 'running' ? { ...t, state: 'done' } : t,
        );
      }
    };
    return () => source.close();
  }, [streamPath, liveTurnId]);

  // The AI's message has arrived (or there is none to wait for): drop the live bubble.
  useEffect(() => {
    if (liveTurn?.state !== 'done') return;
    if (!liveTurn.messageId || messages.some((m) => m.id === liveTurn.messageId)) setLiveTurn(null);
  }, [liveTurn, messages]);

  // Keep the newest message in view unless the reader has scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !mounted) return;
    if (restoreFromBottom.current !== null) {
      el.scrollTop = el.scrollHeight - restoreFromBottom.current;
      restoreFromBottom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, pending, mounted]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
  };

  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const query = new URLSearchParams({ limit: '50', cursor: olderCursor });
      const page = await apiGet<ChatMessagePage>(`${streamPath}?${query.toString()}`);
      const el = scroller.current;
      if (el) restoreFromBottom.current = el.scrollHeight - el.scrollTop;
      addMessages(page.items, false);
      setOlderCursor(page.next_cursor);
    } catch (err) {
      setOlderError(err instanceof ProblemError ? err.detail : 'Could not load older messages.');
    } finally {
      setLoadingOlder(false);
    }
  };

  // Optimistic sends: shown at once as pending, replaced by the stored message on 201.
  const post = async (item: PendingMessage) => {
    setPending((list) => list.map((p) => (p.tempId === item.tempId ? { ...p, error: null } : p)));
    try {
      const result = await apiPost<SendMessageResult>(
        streamPath,
        {
          body: item.body,
          ...(item.attachments.length > 0 && {
            attachments: item.attachments.map((f) => f.file_id),
          }),
        },
        // The same key on Retry: a post that did land is replayed, not stored twice.
        { idempotencyKey: item.key },
      );
      setPending((list) => list.filter((p) => p.tempId !== item.tempId));
      onPosted(result);
    } catch (err) {
      const error =
        err instanceof ProblemError
          ? (err.fieldErrors[0]?.message ?? err.detail)
          : 'Could not send. Check your connection.';
      setPending((list) => list.map((p) => (p.tempId === item.tempId ? { ...p, error } : p)));
    }
  };
  const submit = (body: string, attachments: readonly FileRef[]) => {
    const item: PendingMessage = {
      tempId: uuidv7(),
      key: uuidv7(),
      body,
      attachments,
      error: null,
    };
    stickToBottom.current = true;
    setPending((list) => [...list, item]);
    void post(item);
  };

  const onPosted = (result: SendMessageResult) => {
    stickToBottom.current = true;
    addMessages([result.message], false);
    setAiNotice(result.ai_skipped?.detail ?? null);
    if (result.turn) {
      setLiveTurn({
        id: result.turn.id,
        text: '',
        state: 'running',
        failureCode: null,
        messageId: null,
      });
    }
    afterPost?.();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        aria-label={regionLabel}
        role="region"
      >
        {mounted && (
          <Stream
            messages={messages}
            emptyText={emptyText}
            olderCursor={olderCursor}
            loadingOlder={loadingOlder}
            olderError={olderError}
            onLoadOlder={() => void loadOlder()}
            fileUrl={fileUrl}
            onOpenArtifact={onOpenArtifact}
            artifactHref={artifactHref}
            renderGate={renderGate}
          />
        )}
        {mounted &&
          pending.map((item) => (
            <PendingBubble
              key={item.tempId}
              item={item}
              onRetry={() => void post(item)}
              onDiscard={() => setPending((list) => list.filter((p) => p.tempId !== item.tempId))}
            />
          ))}
        {mounted && liveTurn && (
          <LiveTurnBubble turn={liveTurn} onDismiss={() => setLiveTurn(null)} />
        )}
      </div>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      <div className="px-6 pb-5">
        {pollState !== 'ok' && (
          <p role="status" className="mb-2 text-[12px] text-faint">
            {pollState === 'retrying'
              ? 'Reconnecting. New messages may be delayed.'
              : 'New messages have stopped. Reload the page to catch up.'}
          </p>
        )}
        {aiNotice && (
          <p role="status" className="mb-2 text-[12px] text-muted">
            {aiNotice}
          </p>
        )}
        {canPost ? (
          <Composer
            label={composerLabel}
            mentionNames={mentionNames}
            onSubmit={submit}
            uploadPath={uploadPath}
            onCommand={onCommand}
          />
        ) : (
          <p className="card flex items-center gap-2 px-4 py-3 text-[14px] text-muted">
            <InfoIcon />
            You can read this arena but not post.
          </p>
        )}
      </div>
    </div>
  );
}

function Stream({
  messages,
  emptyText,
  olderCursor,
  loadingOlder,
  olderError,
  onLoadOlder,
  fileUrl,
  onOpenArtifact,
  artifactHref,
  renderGate,
}: {
  messages: readonly ChatMessage[];
  emptyText: string;
  olderCursor: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
  fileUrl?: (fileId: string) => string;
  onOpenArtifact?: (artifactId: string) => void;
  artifactHref?: (artifactId: string) => string;
  renderGate?: (message: ChatMessage) => ReactNode;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-[15px] text-faint">{emptyText}</p>
      </div>
    );
  }
  const byId = new Map(messages.map((m) => [m.id, m]));
  const now = new Date();
  let previousDay = '';
  return (
    <>
      {olderCursor && (
        <div className="mb-4 flex flex-col items-center gap-1">
          <button
            type="button"
            className="btn ghost h-8 px-3 text-[13px]"
            onClick={onLoadOlder}
            disabled={loadingOlder}
          >
            {loadingOlder ? 'Loading…' : 'Load earlier messages'}
          </button>
          {olderError && (
            <p role="alert" className="text-[12px] text-bad">
              {olderError}
            </p>
          )}
        </div>
      )}
      <ol className="space-y-5">
        {messages.map((message) => {
          const day = dayKey(message.created_at);
          const divider = day !== previousDay;
          previousDay = day;
          const parent = message.parent_id ? byId.get(message.parent_id) : undefined;
          return (
            <Fragment key={message.id}>
              {divider && (
                <li className="flex items-center gap-3 text-[13px] text-faint">
                  <span className="h-px flex-1 bg-line" aria-hidden="true" />
                  {dayLabel(message.created_at, now)}
                  <span className="h-px flex-1 bg-line" aria-hidden="true" />
                </li>
              )}
              {message.kind === 'gate' && renderGate ? (
                renderGate(message)
              ) : message.kind === 'event' || message.kind === 'gate' ? (
                <EventCard message={message} onOpenArtifact={onOpenArtifact} />
              ) : (
                <MessageItem
                  message={message}
                  replyTo={parent?.author.display_name}
                  fileUrl={fileUrl}
                  onOpenArtifact={onOpenArtifact}
                  artifactHref={artifactHref}
                />
              )}
            </Fragment>
          );
        })}
      </ol>
    </>
  );
}

/** A Push to Arena card: "<name> pushed goal.md v3 from Private", with View. */
function EventCard({
  message,
  onOpenArtifact,
}: {
  message: ChatMessage;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const artifactId = message.artifact_refs[0];
  return (
    <li className="card flex items-center gap-3 px-4 py-3">
      <span
        aria-hidden="true"
        className="av inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px]"
      >
        {message.author.initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] text-text">{message.body}</p>
        <time dateTime={message.created_at} className="text-[12px] text-faint">
          {timeLabel(message.created_at)}
        </time>
      </div>
      {artifactId && onOpenArtifact && (
        <button
          type="button"
          className="btn h-9 shrink-0 px-3 text-[14px]"
          onClick={() => onOpenArtifact(artifactId)}
        >
          View
        </button>
      )}
    </li>
  );
}

/** File chips; images as thumbnails (inline only for allowlisted images, from the safe route). */
function Attachments({
  files,
  fileUrl,
}: {
  files: readonly FileRef[];
  fileUrl?: (fileId: string) => string;
}) {
  if (files.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-wrap gap-2" aria-label="Attached files">
      {files.map((file) => {
        const url = fileUrl?.(file.file_id);
        const image = IMAGE_TYPES.includes(file.mime_type as (typeof IMAGE_TYPES)[number]);
        return (
          <li key={file.file_id}>
            {image && url ? (
              <a href={url} target="_blank" rel="noopener noreferrer" className="block">
                <img
                  src={url}
                  alt={file.name}
                  loading="lazy"
                  className="max-h-40 max-w-[240px] rounded-lg border border-line object-cover"
                />
              </a>
            ) : (
              <a
                href={url}
                className="chip inline-flex items-center gap-1.5 px-2 py-1 text-[13px]"
                download={file.name}
              >
                <FileIcon size={14} />
                <span className="max-w-[200px] truncate">{file.name}</span>
                <span className="text-faint">{formatBytes(file.size_bytes)}</span>
              </a>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** File cards for the documents an AI reply saved: open the viewer (arena) or the file page. */
function ArtifactCards({
  message,
  onOpenArtifact,
  artifactHref,
}: {
  message: ChatMessage;
  onOpenArtifact?: (artifactId: string) => void;
  artifactHref?: (artifactId: string) => string;
}) {
  if (message.artifact_refs.length === 0) return null;
  const names = new Map((message.artifacts ?? []).map((a) => [a.id, a]));
  const cards = message.artifact_refs.flatMap((id) => {
    const ref = names.get(id);
    return ref ? [ref] : [];
  });
  if (cards.length === 0) return null;
  const inner = (name: string, version: number) => (
    <>
      <FileIcon size={16} />
      <span className="min-w-0 flex-1 truncate text-left font-medium text-text">{name}</span>
      <span className="shrink-0 text-[12px] text-faint">v{version} · Open</span>
    </>
  );
  const cardClass =
    'card flex w-full max-w-[360px] items-center gap-2 px-3 py-2 text-[14px] no-underline hover:border-line2';
  return (
    <ul className="mt-2 space-y-1.5" aria-label="Documents">
      {cards.map((card) => (
        <li key={card.id}>
          {artifactHref ? (
            <Link href={artifactHref(card.id)} className={cardClass}>
              {inner(card.name, card.head_version_no)}
            </Link>
          ) : onOpenArtifact ? (
            <button type="button" className={cardClass} onClick={() => onOpenArtifact(card.id)}>
              {inner(card.name, card.head_version_no)}
            </button>
          ) : (
            <span className={cardClass}>{inner(card.name, card.head_version_no)}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function MessageItem({
  message,
  replyTo,
  fileUrl,
  onOpenArtifact,
  artifactHref,
}: {
  message: ChatMessage;
  replyTo?: string;
  fileUrl?: (fileId: string) => string;
  onOpenArtifact?: (artifactId: string) => void;
  artifactHref?: (artifactId: string) => string;
}) {
  const isAi = message.author.type !== 'user';
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] ${
          isAi ? 'chip ai font-semibold' : 'av'
        }`}
      >
        {message.author.initials}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold text-text">{message.author.display_name}</span>
          {isAi ? (
            <span className="chip ai px-1.5 py-0.5 text-[11px]">AI</span>
          ) : (
            message.author.roles.map((role) => (
              <span key={role} className="chip px-1.5 py-0.5 text-[11px]">
                {role}
              </span>
            ))
          )}
          <time dateTime={message.created_at} className="text-[12px] text-faint">
            {timeLabel(message.created_at)}
          </time>
          {message.parent_id && (
            <span className="text-[12px] text-faint">
              {replyTo ? `replying to ${replyTo}` : 'reply'}
            </span>
          )}
          {message.edited_at && <span className="text-[12px] text-faint">(edited)</span>}
        </div>
        <p
          className={`mt-1 whitespace-pre-wrap break-words text-[15px] leading-relaxed ${
            isAi ? 'rounded-lg border border-ai-line bg-ai-soft px-3 py-2 text-ai-ink' : 'text-text'
          }`}
        >
          {message.body}
        </p>
        <Attachments files={message.attachments} fileUrl={fileUrl} />
        <ArtifactCards
          message={message}
          onOpenArtifact={onOpenArtifact}
          artifactHref={artifactHref}
        />
      </div>
    </li>
  );
}

function LiveTurnBubble({ turn, onDismiss }: { turn: LiveTurn; onDismiss: () => void }) {
  const failed = turn.state === 'failed';
  return (
    <div className="mt-5 flex gap-3" aria-live="polite">
      <span
        aria-hidden="true"
        className="chip ai inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
      >
        AI
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-text">AI</span>
          <span className="chip ai px-1.5 py-0.5 text-[11px]">AI</span>
          {!failed && !turn.text && <span className="text-[12px] text-faint">is typing…</span>}
        </div>
        {failed ? (
          <p
            role="status"
            className="mt-1 flex items-center gap-2 rounded-lg border border-ai-line bg-ai-soft px-3 py-2 text-[14px] text-ai-ink"
          >
            {failureText(turn.failureCode)}
            <button type="button" className="btn ghost h-7 px-2 text-[12px]" onClick={onDismiss}>
              Dismiss
            </button>
          </p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words rounded-lg border border-ai-line bg-ai-soft px-3 py-2 text-[15px] leading-relaxed text-ai-ink">
            {turn.text || <span className="animate-pulse">…</span>}
          </p>
        )}
      </div>
    </div>
  );
}

/** The `@word` being typed at the caret, if any. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  if (!match) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, query };
}

function Composer({
  label,
  mentionNames,
  onSubmit,
  uploadPath,
  onCommand,
}: {
  label: string;
  mentionNames: readonly string[];
  onSubmit: (body: string, attachments: readonly FileRef[]) => void;
  uploadPath?: string;
  onCommand?: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tooLong = text.length > MESSAGE_BODY_MAX_CHARS;
  const empty = text.trim().length === 0 && files.length === 0;

  const upload = async (list: FileList | null) => {
    if (!list || !uploadPath) return;
    setError(null);
    const picked = [...list].slice(0, MESSAGE_ATTACHMENTS_MAX - files.length);
    if (picked.length === 0) {
      setError(`At most ${MESSAGE_ATTACHMENTS_MAX} files per message`);
      return;
    }
    setUploading(true);
    try {
      for (const file of picked) {
        const checked = uploadTypeOf(file);
        if ('error' in checked) {
          setError(checked.error);
          continue;
        }
        const ref = await apiUpload<FileRef>(uploadPath, file, file.name, checked.type);
        setFiles((current) =>
          current.some((f) => f.file_id === ref.file_id) ? current : [...current, ref],
        );
      }
    } catch (err) {
      setError(
        err instanceof ProblemError
          ? (err.fieldErrors[0]?.message ?? err.detail)
          : 'Could not upload the file. Please try again.',
      );
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = '';
    }
  };

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = async () => {
    const typed = text.trim();
    if ((!typed && files.length === 0) || sending || tooLong || uploading) return;
    setSending(true);
    setError(null);
    try {
      if (typed && files.length === 0 && onCommand && (await onCommand(typed))) {
        setText('');
        setMention(null);
        return;
      }
      // Optimistic: the message shows at once; ChatRoom posts it and reconciles (or offers Retry).
      const body = typed || `Shared ${files.map((f) => f.name).join(', ')}`;
      onSubmit(body, files);
      setText('');
      setFiles([]);
      setMention(null);
    } catch (err) {
      setError(
        err instanceof ProblemError
          ? (err.fieldErrors[0]?.message ?? err.detail)
          : 'Something went wrong. Please try again.',
      );
    } finally {
      setSending(false);
      input.current?.focus();
    }
  };

  // @ picker: AI first, then teammates. It only inserts text; people mentions stay plain.
  const options = mention
    ? ['AI', ...mentionNames].filter((name) =>
        name.toLowerCase().startsWith(mention.query.toLowerCase()),
      )
    : [];
  const pickerOpen = options.length > 0;

  const pick = (name: string) => {
    const el = input.current;
    if (!mention || !el) return;
    const caret = el.selectionStart;
    const next = `${text.slice(0, mention.start)}@${name} ${text.slice(caret)}`;
    const at = mention.start + name.length + 2;
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pickerOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActive((i) => (i + step + options.length) % options.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.nativeEvent.isComposing) {
        event.preventDefault();
        pick(options[Math.min(active, options.length - 1)] ?? 'AI');
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMention(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="card flex items-end gap-3 p-2.5 shadow-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {uploadPath && (
        <>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.md,.csv,.json"
            onChange={(event) => void upload(event.target.files)}
          />
          <button
            type="button"
            aria-label={uploading ? 'Uploading' : 'Attach a file'}
            title="Attach a file (images, PDF, text, markdown, CSV, JSON · up to 10 MB)"
            disabled={uploading || sending}
            onClick={() => picker.current?.click()}
            className="btn h-10 w-10 shrink-0 p-0"
          >
            <PlusIcon />
          </button>
        </>
      )}
      <div className="relative min-w-0 flex-1">
        {(files.length > 0 || uploading) && (
          <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Files to send">
            {files.map((file) => (
              <li
                key={file.file_id}
                className="chip inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px]"
              >
                <FileIcon size={12} />
                <span className="max-w-[180px] truncate">{file.name}</span>
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  className="text-faint hover:text-text"
                  onClick={() =>
                    setFiles((current) => current.filter((f) => f.file_id !== file.file_id))
                  }
                >
                  <XIcon size={12} />
                </button>
              </li>
            ))}
            {uploading && <li className="text-[12px] text-faint">Uploading…</li>}
          </ul>
        )}
        {pickerOpen && (
          <ul
            id="arena-mention-picker"
            role="listbox"
            aria-label="Mention"
            className="card absolute bottom-full left-0 mb-2 max-h-56 w-56 overflow-y-auto p-1 shadow-card"
          >
            {options.map((name, i) => (
              <li
                key={name}
                role="option"
                aria-selected={i === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(name);
                }}
                className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-[14px] ${
                  i === active ? 'bg-ai-soft' : ''
                }`}
              >
                {name === 'AI' ? (
                  <span className="chip ai px-1.5 py-0.5 text-[11px]">AI</span>
                ) : (
                  <span className="text-text">{name}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        <label htmlFor="arena-composer" className="block text-[12px] text-faint">
          {label}
        </label>
        <textarea
          id="arena-composer"
          ref={input}
          rows={1}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setMention(mentionQuery(event.target.value, event.target.selectionStart));
            setActive(0);
          }}
          onBlur={() => setMention(null)}
          role="combobox"
          aria-expanded={pickerOpen}
          aria-controls="arena-mention-picker"
          aria-autocomplete="list"
          onKeyDown={onKeyDown}
          aria-invalid={tooLong || undefined}
          aria-describedby={error || tooLong ? 'arena-composer-error' : undefined}
          className="mt-1 block max-h-[200px] w-full resize-none bg-transparent text-[15px] text-text outline-none placeholder:text-faint"
          placeholder="Write a message"
        />
        {(error || tooLong) && (
          <p id="arena-composer-error" role="alert" className="mt-1 text-[12px] text-bad">
            {tooLong ? `At most ${MESSAGE_BODY_MAX_CHARS.toLocaleString()} characters` : error}
          </p>
        )}
      </div>
      <button
        type="submit"
        aria-label={sending ? 'Sending' : 'Send'}
        disabled={empty || sending || tooLong || uploading}
        className="btn pri h-10 w-10 shrink-0 p-0"
      >
        <ArrowUpIcon />
      </button>
    </form>
  );
}
