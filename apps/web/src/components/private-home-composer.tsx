'use client';

import {
  MESSAGE_BODY_MAX_CHARS,
  type PrivateChat,
  type PrivateMessage,
  type SendMessageResult,
  uuidv7,
} from '@saras/contracts';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { announce, type Optimistic, retract, tempId } from '../lib/optimistic';
import { ArrowUpIcon, LockIcon, PlusIcon, SparkIcon } from './icons';
import { SoonTip } from './soon';

// The private home composer (screen 01). Sending creates a chat, posts the message (which asks your
// AI) and opens the chat, passing the AI turn along so its reply (or "AI isn't connected yet")
// shows there. Files, arena links and the model choice come later.

export function PrivateHomeComposer() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Created on the first try, reused on a retry so a failed post does not leave two chats. */
  const chat = useRef<PrivateChat | null>(null);
  const tooLong = text.length > MESSAGE_BODY_MAX_CHARS;
  const empty = text.trim().length === 0;

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || tooLong) return;
    setSending(true);
    setError(null);
    // Optimistic: the chat shows in the sidebar at once, titled like its first message will name it.
    const temp = chat.current ? null : tempId();
    const title = body.split('\n')[0]?.slice(0, 80) ?? null;
    if (temp) {
      announce<Optimistic<PrivateChat>>('chats', {
        id: temp,
        title,
        private_project_id: null,
        bound_project: null,
        model_class: 'balanced',
        last_message_at: null,
        created_at: new Date().toISOString(),
        pending: true,
      });
    }
    try {
      try {
        chat.current ??= await apiPost<PrivateChat>(
          '/private/sessions',
          {},
          { idempotencyKey: uuidv7() },
        );
      } catch (err) {
        if (temp) retract('chats', temp);
        throw err;
      }
      if (temp) announce('chats', { ...chat.current, title, pending: true }, temp);
      router.prefetch(`/private/${chat.current.id}`);
      const result = await apiPost<SendMessageResult<PrivateMessage>>(
        `/private/sessions/${chat.current.id}/messages`,
        { body },
        { idempotencyKey: uuidv7() },
      );
      const turn = result.turn ? `?turn=${encodeURIComponent(result.turn.id)}` : '';
      router.push(`/private/${chat.current.id}${turn}`);
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ProblemError
          ? (err.fieldErrors[0]?.message ?? err.detail)
          : 'Something went wrong. Please try again.',
      );
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <form
      className="card w-full px-5 pb-3 pt-4 shadow-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label htmlFor="private-composer" className="sr-only">
        Message your AI
      </label>
      <textarea
        id="private-composer"
        ref={input}
        rows={2}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        autoFocus
        aria-invalid={tooLong || undefined}
        aria-describedby={error || tooLong ? 'private-composer-error' : undefined}
        placeholder="Write something..."
        className="block max-h-[240px] w-full resize-none bg-transparent text-[16px] text-text outline-none placeholder:text-faint"
      />
      {sending && !error && (
        <p role="status" className="mt-1 text-[12px] text-faint">
          Starting your chat…
        </p>
      )}
      {(error || tooLong) && (
        <p id="private-composer-error" role="alert" className="mt-1 text-[12px] text-bad">
          {tooLong ? `At most ${MESSAGE_BODY_MAX_CHARS.toLocaleString()} characters` : error}
        </p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <span className="w-auto">
          <SoonTip side="top">
            <button
              type="button"
              aria-disabled="true"
              className="btn h-10 w-10 cursor-not-allowed opacity-55"
              aria-label="Add a file"
            >
              <PlusIcon />
            </button>
          </SoonTip>
        </span>
        <span className="chip inline-flex items-center gap-1.5 px-2.5 py-1 text-[13px]">
          <LockIcon size={13} />
          Not linked to an arena
        </span>
        <span className="ml-auto w-auto">
          <SoonTip side="top" label="The AI picks the model for now">
            <button
              type="button"
              aria-disabled="true"
              className="btn h-10 cursor-not-allowed gap-2 px-4 opacity-55"
            >
              <SparkIcon size={14} className="text-ai" />
              Balanced
            </button>
          </SoonTip>
        </span>
        <button
          type="submit"
          disabled={empty || sending || tooLong}
          className="btn pri h-11 w-11"
          aria-label={sending ? 'Sending' : 'Send'}
        >
          <ArrowUpIcon />
        </button>
      </div>
    </form>
  );
}
