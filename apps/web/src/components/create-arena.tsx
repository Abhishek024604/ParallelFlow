'use client';

import {
  type ArenaSummary,
  type CreateArenaInput,
  type CreateArenaResponse,
  CreateArenaSchema,
  InviteEmailSchema,
  MAX_INVITE_EMAILS,
  uuidv7,
} from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { announce, type Optimistic, retract, tempId } from '../lib/optimistic';
import { CheckIcon, CopyIcon, XIcon } from './icons';

// Create arena (screen 19). A native <dialog> (focus trap, Escape, inert background) opened from the
// empty home and the sidebar. On success it shows each invite link once, with Copy, then opens the
// arena. Each submit sends a fresh Idempotency-Key; the CSRF header comes from apiPost.

const CreateArenaContext = createContext<{ open: () => void }>({ open: () => {} });

export function useCreateArena() {
  return useContext(CreateArenaContext);
}

export function CreateArenaProvider({ children }: { children: ReactNode }) {
  const [openCount, setOpenCount] = useState(0);
  const open = useCallback(() => setOpenCount((n) => n + 1), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <CreateArenaContext.Provider value={value}>
      {children}
      {/* A new key per opening resets the form. */}
      {openCount > 0 && <CreateArenaDialog key={openCount} />}
    </CreateArenaContext.Provider>
  );
}

/** A button that opens the dialog. */
export function CreateArenaButton({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const { open } = useCreateArena();
  return (
    <button type="button" onClick={open} className={className}>
      {children}
    </button>
  );
}

/** Splits typed text on commas, semicolons and whitespace. */
export function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

interface FieldErrors {
  name?: string;
  description?: string;
  emails?: string;
  form?: string;
}

function CreateArenaDialog() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const ids = { name: useId(), description: useId(), emails: useId(), hint: useId() };
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreateArenaResponse | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const close = () => ref.current?.close();

  /** Turns typed text into chips. Returns false when something was invalid. */
  const commitDraft = (text = draft): boolean => {
    const parts = splitEmails(text);
    if (!parts.length) {
      setDraft('');
      return true;
    }
    const next = [...emails];
    const bad: string[] = [];
    for (const part of parts) {
      const parsed = InviteEmailSchema.safeParse(part);
      if (!parsed.success) bad.push(part);
      else if (!next.includes(parsed.data)) next.push(parsed.data);
    }
    if (next.length > MAX_INVITE_EMAILS) {
      setErrors((e) => ({
        ...e,
        emails: `You can invite up to ${MAX_INVITE_EMAILS} teammates at a time.`,
      }));
      return false;
    }
    setEmails(next);
    setDraft(bad.join(', '));
    setErrors((e) => ({
      ...e,
      emails: bad.length
        ? `Check ${bad.length === 1 ? 'this email' : 'these emails'}: ${bad.join(', ')}`
        : undefined,
    }));
    return bad.length === 0;
  };

  const onEmailKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !draft && emails.length) {
      setEmails(emails.slice(0, -1));
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!commitDraft()) return;
    const pending = [...emails];
    for (const part of splitEmails(draft)) {
      const parsed = InviteEmailSchema.safeParse(part);
      if (parsed.success && !pending.includes(parsed.data)) pending.push(parsed.data);
    }
    const input: CreateArenaInput = {
      name,
      ...(description.trim() && { description }),
      invite_emails: pending,
    };
    const parsed = CreateArenaSchema.safeParse(input);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === 'name') next.name ??= issue.message;
        else if (field === 'description') next.description ??= issue.message;
        else next.emails ??= issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setSubmitting(true);
    // Optimistic: the arena shows in the sidebar at once, then is replaced by the created one.
    const temp = tempId();
    announce<Optimistic<ArenaSummary>>('arenas', {
      id: temp,
      arena_id: temp,
      name: input.name,
      description: null,
      key:
        input.name
          .replace(/[^\p{L}]/gu, '')
          .slice(0, 3)
          .toUpperCase() || 'NEW',
      cycle: null,
      stage: null,
      member_count: 1,
      role: 'owner',
      archived: false,
      pending: true,
    });
    try {
      const response = await apiPost<CreateArenaResponse>('/arenas', input, {
        idempotencyKey: uuidv7(),
      });
      announce<ArenaSummary>('arenas', response, temp);
      setCreated(response);
      router.refresh();
    } catch (err) {
      retract('arenas', temp);
      if (err instanceof ProblemError) {
        const next: FieldErrors = {};
        for (const f of err.fieldErrors) {
          if (f.field === 'name') next.name ??= f.message;
          else if (f.field === 'description') next.description ??= f.message;
          else if (f.field.startsWith('invite_emails')) next.emails ??= f.message;
        }
        if (!next.name && !next.description && !next.emails) next.form = err.detail;
        setErrors(next);
      } else {
        setErrors({ form: 'Something went wrong. Please try again.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const pendingCount = emails.length + (draft.trim() ? splitEmails(draft).length : 0);
  const submitLabel =
    pendingCount === 0
      ? 'Create arena'
      : `Create and get ${pendingCount} invite link${pendingCount === 1 ? '' : 's'}`;

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${ids.name}-title`}
      className="card m-auto w-[540px] max-w-[calc(100vw-32px)] p-0 text-text shadow-pop"
    >
      <div className="px-6 pb-6 pt-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id={`${ids.name}-title`} className="text-[22px] font-bold">
              {created ? 'Your arena is ready' : 'Create arena'}
            </h2>
            <p className="mt-1 text-muted">
              {created
                ? created.invites.length
                  ? 'Send each teammate their link. Links work once, for that email, for 7 days.'
                  : 'Invite teammates later from the arena.'
                : 'A shared space for one project.'}
            </p>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="btn ghost h-9 w-9 shrink-0"
          >
            <XIcon size={18} />
          </button>
        </div>

        {created ? (
          <CreatedView
            created={created}
            onOpen={() => {
              close();
              router.push(`/arena/${created.id}`);
              router.refresh();
            }}
          />
        ) : (
          <form onSubmit={submit} noValidate className="mt-5">
            <label htmlFor={ids.name} className="block font-medium">
              Arena name
            </label>
            <input
              id={ids.name}
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
              autoComplete="off"
              aria-invalid={Boolean(errors.name)}
              aria-describedby={`${ids.name}-hint`}
              className="inp mt-2 h-11 w-full px-3 text-[15px]"
            />
            <p
              id={`${ids.name}-hint`}
              className={`mt-1.5 text-[12px] ${errors.name ? 'text-bad' : 'text-faint'}`}
            >
              {errors.name ?? 'Usually the project or product name.'}
            </p>

            <label htmlFor={ids.description} className="mt-5 block font-medium">
              What are you building? <span className="font-normal text-faint">(optional)</span>
            </label>
            <textarea
              id={ids.description}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              rows={2}
              aria-invalid={Boolean(errors.description)}
              className="inp mt-2 w-full resize-y px-3 py-2.5 text-[15px]"
            />
            {errors.description && (
              <p className="mt-1.5 text-[12px] text-bad">{errors.description}</p>
            )}

            <label htmlFor={ids.emails} className="mt-5 block font-medium">
              Invite teammates
            </label>
            <div
              className="inp mt-2 flex min-h-[80px] flex-wrap content-start items-center gap-2 p-2"
              onClick={() => document.getElementById(ids.emails)?.focus()}
            >
              {emails.map((email) => (
                <span
                  key={email}
                  className="chip inline-flex items-center gap-1.5 py-1 pl-2.5 pr-1.5 text-[13px] text-text"
                >
                  {email}
                  <button
                    type="button"
                    onClick={() => setEmails(emails.filter((x) => x !== email))}
                    aria-label={`Remove ${email}`}
                    className="rounded text-faint hover:text-text"
                  >
                    <XIcon size={12} />
                  </button>
                </span>
              ))}
              <input
                id={ids.emails}
                type="text"
                inputMode="email"
                value={draft}
                onChange={(e) => {
                  const value = e.target.value;
                  if (/[,;\s]$/.test(value)) commitDraft(value);
                  else setDraft(value);
                }}
                onKeyDown={onEmailKey}
                onBlur={() => commitDraft()}
                onPaste={(e) => {
                  const text = e.clipboardData.getData('text');
                  if (splitEmails(text).length > 1) {
                    e.preventDefault();
                    commitDraft(`${draft} ${text}`);
                  }
                }}
                placeholder={emails.length ? '' : 'name@company.com'}
                autoComplete="off"
                aria-invalid={Boolean(errors.emails)}
                aria-describedby={ids.hint}
                className="min-w-[180px] flex-1 bg-transparent px-1.5 py-1 text-[14px] text-text outline-none placeholder:text-faint"
              />
            </div>
            <p
              id={ids.hint}
              className={`mt-1.5 text-[12px] ${errors.emails ? 'text-bad' : 'text-faint'}`}
            >
              {errors.emails ??
                'Separate emails with a comma or Enter. Each person gets an invite link to send them; they join after they sign up with that email.'}
            </p>

            {errors.form && (
              <p role="alert" className="chip bad mt-4 px-3 py-2 text-[13px]">
                {errors.form}
              </p>
            )}

            <div className="mt-5 flex justify-end gap-3 border-t border-line pt-5">
              <button type="button" onClick={close} className="btn h-10 px-4">
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="btn pri h-10 px-4">
                {submitting ? 'Creating…' : submitLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
      className="btn h-8 shrink-0 gap-1.5 px-2.5 text-[13px]"
    >
      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function CreatedView({ created, onOpen }: { created: CreateArenaResponse; onOpen: () => void }) {
  return (
    <div className="mt-5">
      {created.invites.length > 0 && (
        <ul className="space-y-2">
          {created.invites.map((invite) => (
            <li key={invite.email} className="card flex items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{invite.email}</div>
                <div className="mono truncate text-[12px] text-faint">
                  {invite.link ?? 'Link already shown. Ask for a new one later.'}
                </div>
              </div>
              {invite.link && <CopyButton text={invite.link} />}
            </li>
          ))}
        </ul>
      )}
      {created.invites.length > 0 && (
        <p className="mt-3 text-[12px] text-faint">
          Copy the links now: for safety they are shown only once.
        </p>
      )}
      <div className="mt-5 flex justify-end border-t border-line pt-5">
        <button type="button" onClick={onOpen} className="btn pri h-10 gap-2 px-4">
          Open {created.name}
        </button>
      </div>
    </div>
  );
}
