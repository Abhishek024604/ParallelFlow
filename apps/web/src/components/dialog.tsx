'use client';

import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ProblemError } from '../lib/api-browser';

// The one pattern for confirming and renaming things (arenas, projects, chats, files): a native
// <dialog> (focus trap, Escape, inert background), a clear title, what will happen, and one primary
// action. Destructive actions use the red danger button; deleting something big can ask you to type
// its name first. Errors from the API show inside the dialog; the dialog stays open until it works.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail ?? 'That did not work. Please try again.')
    : 'That did not work. Please try again.';

function Shell({
  onClose,
  children,
}: {
  onClose: () => void;
  children: (titleId: string) => ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby={titleId}
      className="card m-auto w-[min(440px,calc(100vw-32px))] p-0 shadow-pop backdrop:bg-scrim"
    >
      {children(titleId)}
    </dialog>
  );
}

export interface ConfirmProps {
  title: string;
  /** What will happen, in plain words. */
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** Type this exact text to enable the action (e.g. the arena's name). */
  confirmText?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  confirmText,
  onConfirm,
  onClose,
}: ConfirmProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const ready = !confirmText || typed.trim() === confirmText;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Shell onClose={onClose}>
      {(titleId) => (
        <form onSubmit={(e) => void submit(e)} className="p-6">
          <h2 id={titleId} className="text-[18px] font-semibold text-text">
            {title}
          </h2>
          <div className="mt-2 text-[14px] leading-relaxed text-muted">{body}</div>
          {confirmText && (
            <div className="mt-4">
              <label htmlFor={inputId} className="block text-[13px] text-muted">
                Type <span className="font-semibold text-text">{confirmText}</span> to confirm
              </label>
              <input
                id={inputId}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoFocus
                className="inp mt-1.5 w-full"
              />
            </div>
          )}
          {error && (
            <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn h-10 px-4" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn ${danger ? 'danger' : 'pri'} h-10 px-4`}
              disabled={!ready || busy}
              autoFocus={!confirmText}
            >
              {busy ? 'Working…' : confirmLabel}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}

export interface RenameProps {
  title: string;
  label: string;
  initial: string;
  maxLength: number;
  /** Optional hint under the field, e.g. the naming rule. */
  hint?: string;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

export function RenameDialog({
  title,
  label,
  initial,
  maxLength,
  hint,
  onSave,
  onClose,
}: RenameProps) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const trimmed = name.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    if (trimmed === initial) return onClose();
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };
  return (
    <Shell onClose={onClose}>
      {(titleId) => (
        <form onSubmit={(e) => void submit(e)} className="p-6">
          <h2 id={titleId} className="text-[18px] font-semibold text-text">
            {title}
          </h2>
          <label htmlFor={inputId} className="mt-4 block text-[13px] font-medium text-text">
            {label}
          </label>
          <input
            id={inputId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={maxLength}
            autoComplete="off"
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            className="inp mt-1.5 w-full"
          />
          {hint && <p className="mt-1.5 text-[12px] text-faint">{hint}</p>}
          {error && (
            <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
              {error}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <button type="button" className="btn h-10 px-4" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn pri h-10 px-4" disabled={!trimmed || busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </Shell>
  );
}
