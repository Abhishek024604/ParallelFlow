'use client';

import {
  type FileRef,
  MESSAGE_ATTACHMENTS_MAX,
  MESSAGE_BODY_MAX_CHARS,
  type PrivateChat,
  type PrivateMessage,
  type SendMessageResult,
  uuidv7,
} from '@saras/contracts';
import { useRouter } from 'next/navigation';
import { type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import { apiPost, apiUpload, ProblemError } from '../lib/api-browser';
import { uploadTypeOf } from '../lib/files';
import { announce, type Optimistic, retract, tempId } from '../lib/optimistic';
import { useFileDrop } from '../lib/use-file-drop';
import { ArrowUpIcon, FileIcon, LockIcon, PlusIcon, SparkIcon, XIcon } from './icons';
import { SoonTip } from './soon';

// The private home composer (screen 01). Sending creates a chat, posts the message (which asks your
// AI) and opens the chat, passing the AI turn along so its reply (or "AI isn't connected yet")
// shows there. Files (+ or drag and drop) upload to your Private files first and go with the first
// message. Arena links and the model choice come later.

const errorText = (err: unknown, fallback: string): string =>
  err instanceof ProblemError ? (err.fieldErrors[0]?.message ?? err.detail) : fallback;

export function PrivateHomeComposer() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRef[]>([]);
  const [uploading, setUploading] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  /** Created on the first try, reused on a retry so a failed post does not leave two chats. */
  const chat = useRef<PrivateChat | null>(null);
  const tooLong = text.length > MESSAGE_BODY_MAX_CHARS;
  const empty = text.trim().length === 0 && files.length === 0;

  const upload = async (list: FileList | null) => {
    if (!list) return;
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
        const ref = await apiUpload<FileRef>('/private/files', file, file.name, checked.type);
        setFiles((current) =>
          current.some((f) => f.file_id === ref.file_id) ? current : [...current, ref],
        );
      }
    } catch (err) {
      setError(errorText(err, 'Could not upload the file. Please try again.'));
    } finally {
      setUploading(false);
      if (picker.current) picker.current.value = '';
    }
  };
  const drop = useFileDrop((list) => void upload(list), !sending);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  const send = async () => {
    const typed = text.trim();
    if ((!typed && files.length === 0) || sending || tooLong || uploading) return;
    const body = typed || `Shared ${files.map((f) => f.name).join(', ')}`;
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
        {
          body,
          ...(files.length > 0 && { attachments: files.map((f) => f.file_id) }),
        },
        { idempotencyKey: uuidv7() },
      );
      const turn = result.turn ? `?turn=${encodeURIComponent(result.turn.id)}` : '';
      router.push(`/private/${chat.current.id}${turn}`);
      router.refresh();
    } catch (err) {
      setError(errorText(err, 'Something went wrong. Please try again.'));
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
      {...drop.handlers}
      className={`card relative w-full px-5 pb-3 pt-4 shadow-card focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-acc ${
        drop.dragging ? 'outline-2 outline-dashed outline-offset-2 outline-line2' : ''
      }`}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {drop.dragging && (
        <p className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-panel/90 text-[15px] font-medium text-text">
          Drop files to attach
        </p>
      )}
      {(files.length > 0 || uploading) && (
        <ul className="mb-2 flex flex-wrap gap-1.5" aria-label="Files to send">
          {files.map((file) => (
            <li
              key={file.file_id}
              className="chip inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px]"
            >
              <FileIcon size={12} />
              <span className="max-w-[200px] truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                className="text-faint hover:text-text"
                disabled={sending}
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
          className="btn h-10 w-10 p-0"
        >
          <PlusIcon />
        </button>
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
          disabled={empty || sending || tooLong || uploading}
          className="btn pri h-11 w-11"
          aria-label={sending ? 'Sending' : 'Send'}
        >
          <ArrowUpIcon />
        </button>
      </div>
    </form>
  );
}
