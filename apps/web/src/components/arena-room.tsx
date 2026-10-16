'use client';

import {
  AI_NOT_CONNECTED_CODES,
  type ArenaMessage,
  type ArenaMessagePage,
  type ArenaTurnStreamEvent,
  MESSAGE_BODY_MAX_CHARS,
  MESSAGE_PAGE_MAX,
  type SendArenaMessageResult,
  uuidv7,
} from '@saras/contracts';
import {
  Fragment,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { apiGet, apiPost, ProblemError } from '../lib/api-browser';
import { dayKey, dayLabel, mergeMessages, timeLabel } from '../lib/chat';
import { ArrowUpIcon, InfoIcon, PlusIcon } from './icons';
import { SoonTip } from './soon';

// The arena stream and composer (screen 04, build step 3). The server page renders the latest page;
// from then on this polls GET …/arena/messages?after=<latest_cursor> every 2 s while the tab is
// visible (paused when hidden, backing off on errors) and merges by id, so a message posted here and
// returned again by the next poll shows once. Bodies are plain text: React escapes them and
// `whitespace-pre-wrap` keeps line breaks. Nothing here logs message content.
//
// @AI (build step 4): a post that queued an AI turn opens an EventSource on
// /v1/projects/{id}/arena/turns/{turn}/events (a streaming route handler, not the buffering /v1
// rewrite) and shows the live text in a Dusk bubble until the AI's message arrives by polling.

const POLL_MS = 2_000;
const MAX_BACKOFF_MS = 30_000;
/** Within this many px of the bottom counts as "at the bottom": new messages scroll into view. */
const STICK_PX = 80;

const messagesPath = (arenaId: string) => `/projects/${encodeURIComponent(arenaId)}/arena/messages`;
const turnEventsPath = (arenaId: string, turnId: string) =>
  `/v1/projects/${encodeURIComponent(arenaId)}/arena/turns/${encodeURIComponent(turnId)}/events`;

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
  const [messages, setMessages] = useState<readonly ArenaMessage[]>(initial.items);
  const [olderCursor, setOlderCursor] = useState(initial.next_cursor);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [pollState, setPollState] = useState<'ok' | 'retrying' | 'stopped'>('ok');
  const [announcement, setAnnouncement] = useState('');
  // Times and "Today" depend on the browser's time zone, so the stream renders after mount.
  const [mounted, setMounted] = useState(false);
  const [liveTurn, setLiveTurn] = useState<LiveTurn | null>(null);
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
    (incoming: readonly ArenaMessage[], announce: boolean) => {
      if (incoming.length === 0) return;
      setMessages((current) => mergeMessages(current, incoming));
      if (announce) {
        const fromOthers = incoming.filter((m) => m.author.id !== viewerId);
        const last = fromOthers.at(-1);
        if (last) setAnnouncement(`New message from ${last.author.display_name}`);
      }
    },
    [viewerId],
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
        const page = await apiGet<ArenaMessagePage>(
          `${messagesPath(arenaId)}?${query.toString()}`,
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
  }, [arenaId, addMessages]);

  // Live text of the AI turn this viewer started. Polling still delivers the final message.
  const liveTurnId = liveTurn?.id;
  useEffect(() => {
    if (!liveTurnId) return;
    const source = new EventSource(turnEventsPath(arenaId, liveTurnId));
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
  }, [arenaId, liveTurnId]);

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
  }, [messages, mounted]);

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
      const page = await apiGet<ArenaMessagePage>(`${messagesPath(arenaId)}?${query.toString()}`);
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

  const onPosted = (result: SendArenaMessageResult) => {
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
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
        aria-label="Arena messages"
        role="region"
      >
        {mounted && (
          <Stream
            messages={messages}
            olderCursor={olderCursor}
            loadingOlder={loadingOlder}
            olderError={olderError}
            onLoadOlder={() => void loadOlder()}
          />
        )}
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
            arenaId={arenaId}
            arenaKey={arenaKey}
            mentionNames={memberNames}
            onPosted={onPosted}
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
  olderCursor,
  loadingOlder,
  olderError,
  onLoadOlder,
}: {
  messages: readonly ArenaMessage[];
  olderCursor: string | null;
  loadingOlder: boolean;
  olderError: string | null;
  onLoadOlder: () => void;
}) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-[15px] text-faint">No messages yet. Say hello to your teammates.</p>
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
              <MessageItem message={message} replyTo={parent?.author.display_name} />
            </Fragment>
          );
        })}
      </ol>
    </>
  );
}

function MessageItem({ message, replyTo }: { message: ArenaMessage; replyTo?: string }) {
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
  arenaId,
  arenaKey,
  mentionNames,
  onPosted,
}: {
  arenaId: string;
  arenaKey: string;
  mentionNames: readonly string[];
  onPosted: (result: SendArenaMessageResult) => void;
}) {
  const [text, setText] = useState('');
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const tooLong = text.length > MESSAGE_BODY_MAX_CHARS;
  const empty = text.trim().length === 0;

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || tooLong) return;
    setSending(true);
    setError(null);
    try {
      const result = await apiPost<SendArenaMessageResult>(
        messagesPath(arenaId),
        { body },
        { idempotencyKey: uuidv7() },
      );
      setText('');
      setMention(null);
      onPosted(result);
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
      <span className="w-auto shrink-0">
        <SoonTip side="top">
          <button
            type="button"
            aria-disabled="true"
            aria-label="Attach a file"
            className="btn h-10 w-10 cursor-not-allowed p-0 opacity-55"
          >
            <PlusIcon />
          </button>
        </SoonTip>
      </span>
      <div className="relative min-w-0 flex-1">
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
          Message the Arena · everyone in {arenaKey} can see this
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
        disabled={empty || sending || tooLong}
        className="btn pri h-10 w-10 shrink-0 p-0"
      >
        <ArrowUpIcon />
      </button>
    </form>
  );
}
