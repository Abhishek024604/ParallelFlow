'use client';

import {
  type Artifact,
  type ArenaList,
  type ArenaSummary,
  type CopyFromArenaResult,
  formatBytes,
  type PrivateChat,
  type PrivateChatList,
  type PrivateMessage,
  type PushPreview,
  type PushResult,
  uuidv7,
  isStandardFileName,
} from '@parallelflow/contracts';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { apiGet, apiPost, ProblemError } from '../lib/api-browser';
import { editedAgo } from '../lib/files';
import { ArenaKey } from './arena-bits';
import { CheckIcon, FileIcon, LockIcon, XIcon } from './icons';

// The bridge in the web app (build step 6, screen 03): Push to Arena and Bring context. Both
// dialogs are native <dialog>s (focus trap, Escape). The Push button is the one orange CTA.

const errorText = (err: unknown, fallback: string) =>
  err instanceof ProblemError ? (err.fieldErrors[0]?.message ?? err.detail) : fallback;

function useModal(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return {
    ref,
    close: () => ref.current?.close(),
    props: { ref, onClose },
  };
}

function UploadIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 15V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Push to Arena (screen 03). `choices`: other files of the chat to pick from. */
export function PushDialog({
  artifact,
  versionNo,
  choices = [],
  initialProjectId,
  onClose,
  onPushed,
}: {
  artifact: Artifact;
  versionNo?: number;
  choices?: Artifact[];
  /** The arena it was dropped on (prefilled; still confirmed here). */
  initialProjectId?: string;
  onClose: () => void;
  onPushed: (result: PushResult, arena: { project_id: string; name: string }) => void;
}) {
  const modal = useModal(onClose);
  const [chosen, setChosen] = useState(artifact);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [mode, setMode] = useState<'new' | 'new_version'>('new');
  const [requestGate, setRequestGate] = useState(false);
  // The file's standard name in the arena (ADR-038), suggested by the preview, editable.
  const [arenaName, setArenaName] = useState('');
  const nameOk = isStandardFileName(arenaName.trim());
  const nameId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const version =
    chosen.id === artifact.id ? (versionNo ?? chosen.head_version_no) : chosen.head_version_no;

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ version_no: String(version) });
    if (projectId) query.set('project_id', projectId);
    setError(null);
    apiGet<PushPreview>(
      `/artifacts/${encodeURIComponent(chosen.id)}/push-preview?${query.toString()}`,
      controller.signal,
    ).then(
      (p) => {
        setPreview(p);
        setMode(p.mode);
        setArenaName(p.arena_name ?? '');
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not prepare the push.'));
      },
    );
    return () => controller.abort();
  }, [chosen.id, version, projectId]);

  const destination = preview?.destination ?? null;
  // A copy of this arena's file whose arena file moved on since the copy (ADR-041).
  const upstream = preview?.upstream ?? null;
  const replacing = Boolean(upstream?.newer) && mode === 'new_version';
  const push = async () => {
    if (!destination || busy || (!nameOk && !(upstream && mode === 'new_version'))) return;
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<PushResult>(
        `/artifacts/${encodeURIComponent(chosen.id)}/push`,
        {
          project_id: destination.project_id,
          version_no: version,
          mode,
          name: arenaName.trim(),
          ...(requestGate && preview?.gate_available && { request_gate: true }),
          ...(replacing && { replace_newer: true }),
        },
        { idempotencyKey: uuidv7() },
      );
      onPushed(result, destination);
      modal.close();
    } catch (err) {
      setError(errorText(err, 'Could not push. Please try again.'));
    } finally {
      setBusy(false);
    }
  };

  const label = `${chosen.name} v${version}`;
  return (
    <dialog
      {...modal.props}
      aria-labelledby="push-title"
      className="card m-auto w-[640px] max-w-[calc(100vw-32px)] p-0 text-text shadow-pop"
    >
      <div className="flex items-start gap-4 border-b border-line px-6 py-5">
        <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-ink text-on-ink">
          <UploadIcon />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="push-title" className="text-[20px] font-bold">
            Push to Arena
          </h2>
          <p className="mt-0.5 text-[14px] text-muted">
            Share one artifact with your team. Your private conversation is never shared.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="btn ghost h-9 w-9 shrink-0"
          onClick={modal.close}
        >
          <XIcon size={18} />
        </button>
      </div>

      <div className="space-y-5 px-6 py-5">
        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-faint">Artifact</h3>
          <div className="card mt-2 flex items-center gap-3 px-4 py-3">
            <FileIcon />
            {choices.length > 1 ? (
              <select
                aria-label="File to push"
                value={chosen.id}
                onChange={(e) => {
                  const next = choices.find((c) => c.id === e.target.value);
                  if (next) setChosen(next);
                }}
                className="inp h-8 px-2 font-mono text-[14px]"
              >
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="font-mono text-[15px]">{chosen.name}</span>
            )}
            <span className="chip px-1.5 py-0.5 text-[12px]">v{version}</span>
            {preview && (
              <span className="ml-auto text-[13px] text-faint">
                {formatBytes(preview.version.size_bytes)} · {editedAgo(preview.version.created_at)}
              </span>
            )}
          </div>
        </section>

        <section>
          <h3 className="text-[12px] font-semibold uppercase tracking-wide text-faint">
            Destination
          </h3>
          {preview?.destination_locked && destination ? (
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-line bg-raise px-4 py-3">
              <ArenaKey arenaKey={destination.key} />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{destination.name} · Arena</p>
                <p className="text-[13px] text-muted">Visible to everyone in this arena</p>
              </div>
              <span className="chip inline-flex items-center gap-1.5 px-2 py-0.5 text-[12px]">
                <LockIcon size={12} />
                Locked to linked arena
              </span>
            </div>
          ) : preview && preview.arenas.length === 0 ? (
            <p className="mt-2 text-[14px] text-muted">
              You are not in an arena where you can push files yet.
            </p>
          ) : (
            <select
              aria-label="Arena"
              value={destination?.project_id ?? ''}
              onChange={(e) => setProjectId(e.target.value || null)}
              className="inp mt-2 h-10 w-full px-2.5 text-[15px]"
            >
              <option value="">Choose an arena</option>
              {preview?.arenas.map((a) => (
                <option key={a.project_id} value={a.project_id}>
                  {a.name} ({a.key})
                </option>
              ))}
            </select>
          )}
        </section>

        {destination && preview && (
          <p className="text-[14px] text-muted" data-testid="push-mapping">
            Private v{version} →{' '}
            {mode === 'new_version' && preview.existing_version_no
              ? `becomes ${destination.name} v${preview.existing_version_no + 1}`
              : `new file in ${destination.name}, v1`}
          </p>
        )}

        {destination && upstream && (
          <p className="text-[14px] text-muted">
            Copied from {destination.name} · {upstream.name} v{upstream.copied_version_no}. Pushing
            adds a version to that same file.
          </p>
        )}

        {destination && upstream?.newer && mode === 'new_version' && (
          <section
            aria-labelledby="push-newer"
            className="rounded-lg border border-warn-line bg-warn-soft px-4 py-3"
          >
            <h3 id="push-newer" className="font-semibold text-warn">
              {upstream.name} changed in the arena since your copy
            </h3>
            <p className="mt-1 text-[14px] text-muted">
              The arena has v{upstream.arena_version_no}; you copied v{upstream.copied_version_no}.
              Pushing replaces it with yours as v{upstream.arena_version_no + 1}. Their changes stay
              in the version history. Below: the arena&rsquo;s v{upstream.arena_version_no} → yours.
            </p>
            {preview?.upstream_diff && (
              <pre className="mt-2 max-h-[220px] overflow-auto rounded-md border border-line bg-panel p-2 font-mono text-[12px] leading-5">
                {preview.upstream_diff.map((line, i) => (
                  <span
                    // Diff lines have no identity of their own; their order never changes here.
                    key={i}
                    className={`block whitespace-pre-wrap ${
                      line.op === '+' ? 'text-ok' : line.op === '-' ? 'text-bad' : 'text-faint'
                    }`}
                  >
                    {line.op} {line.text}
                  </span>
                ))}
                {preview.upstream_diff_truncated && (
                  <span className="block text-faint">… more changes not shown</span>
                )}
              </pre>
            )}
          </section>
        )}

        {destination && preview && !(upstream && mode === 'new_version') && (
          <section>
            <label
              htmlFor={nameId}
              className="text-[12px] font-semibold uppercase tracking-wide text-faint"
            >
              Name in the arena
            </label>
            <input
              id={nameId}
              value={arenaName}
              onChange={(e) => setArenaName(e.target.value)}
              aria-invalid={!nameOk}
              aria-describedby={`${nameId}-hint`}
              autoComplete="off"
              spellCheck={false}
              className="inp mt-2 w-full font-mono text-[14px]"
            />
            <p
              id={`${nameId}-hint`}
              className={`mt-1.5 text-[12px] ${nameOk ? 'text-faint' : 'text-bad'}`}
            >
              {nameOk
                ? 'Arena files use standard names, so everyone finds them in the same place.'
                : 'Use a standard name: plan, requirements, hld, lld, architecture, build, test, deploy or maintain, optionally with a suffix (lld-auth.md).'}
            </p>
          </section>
        )}

        {destination && preview && (
          <fieldset>
            <legend className="text-[12px] font-semibold uppercase tracking-wide text-faint">
              How to add it
            </legend>
            <div className="mt-2 space-y-2">
              {preview.existing_artifact_id && (
                <label
                  className={`flex cursor-pointer gap-3 rounded-lg border px-4 py-3 ${
                    mode === 'new_version' ? 'border-ink bg-raise' : 'border-line'
                  }`}
                >
                  <input
                    type="radio"
                    name="push-mode"
                    checked={mode === 'new_version'}
                    onChange={() => setMode('new_version')}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-semibold">
                      New version of the Arena’s {chosen.name}
                    </span>
                    <span className="block text-[13px] text-muted">
                      Arena has v{preview.existing_version_no}. This becomes v
                      {(preview.existing_version_no ?? 0) + 1}
                      {preview.diff_summary ? ` · ${preview.diff_summary}` : ''}
                    </span>
                  </span>
                </label>
              )}
              <label
                className={`flex cursor-pointer gap-3 rounded-lg border px-4 py-3 ${
                  mode === 'new' ? 'border-ink bg-raise' : 'border-line'
                }`}
              >
                <input
                  type="radio"
                  name="push-mode"
                  checked={mode === 'new'}
                  onChange={() => setMode('new')}
                  className="mt-1"
                />
                <span>
                  <span className="block font-semibold">
                    {preview.existing_artifact_id
                      ? 'Add as a separate artifact'
                      : 'Add as a new artifact'}
                  </span>
                  <span className="block text-[13px] text-muted">
                    {preview.existing_artifact_id
                      ? `Keeps the current ${chosen.name} as is`
                      : `${arenaName || chosen.name} v1 in the arena${preview.diff ? ` · ${preview.diff.added} lines` : ''}`}
                  </span>
                </span>
              </label>
            </div>
          </fieldset>
        )}

        <div className="space-y-3">
          {/* Push and the gate request run in one transaction on the API. */}
          <label
            className={`flex gap-3 ${preview?.gate_available ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}
          >
            <input
              type="checkbox"
              className="mt-1"
              disabled={!preview?.gate_available}
              checked={requestGate && Boolean(preview?.gate_available)}
              onChange={(e) => setRequestGate(e.target.checked)}
            />
            <span>
              <span className="block font-medium">
                Request the {preview?.gate_available?.stage ?? 'stage'} gate after pushing
              </span>
              <span className="block text-[13px] text-muted">
                {preview?.gate_available
                  ? `The gate approvers are asked to move Cycle ${preview.gate_available.cycle_number} on.`
                  : 'Not available: the gate is already waiting, or you cannot request it.'}
              </span>
            </span>
          </label>
          <label className="flex cursor-not-allowed gap-3 opacity-60">
            <input type="checkbox" disabled className="mt-1" />
            <span>
              <span className="block font-medium">
                Notify members{' '}
                <span className="chip ml-1 px-1.5 py-0.5 text-[11px]">Coming soon</span>
              </span>
              <span className="block text-[13px] text-muted">
                Coming soon: teammates see the push in the arena stream.
              </span>
            </span>
          </label>
        </div>

        <p className="flex gap-2 rounded-lg border border-ok-line bg-ok-soft px-4 py-3 text-[14px] text-ok">
          <CheckIcon size={16} />
          <span>
            Only the content of {label} will be shared. The chat, your messages and your other files
            stay private.
            {preview?.binds_session && destination
              ? ` This chat becomes linked to ${destination.name}.`
              : ''}
          </span>
        </p>

        {error && (
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-end gap-3 border-t border-line px-6 py-4">
        <button type="button" className="btn h-11 px-5" onClick={modal.close}>
          Cancel
        </button>
        <button
          type="button"
          className="btn cta h-11 gap-2 px-5"
          disabled={!destination || busy || (!nameOk && !(upstream && mode === 'new_version'))}
          onClick={() => void push()}
        >
          <UploadIcon />
          {busy
            ? 'Pushing…'
            : replacing
              ? 'Replace with mine'
              : destination
                ? `Push to ${destination.key} Arena`
                : 'Push to Arena'}
        </button>
      </div>
    </dialog>
  );
}

/** Copies arena files into a chat (ADR-041): into `chatId`, or a new chat linked to the arena. */
export function copyArenaFiles(
  projectId: string,
  artifactIds: readonly string[],
  chatId: string | null,
): Promise<CopyFromArenaResult> {
  const body = { project_id: projectId, artifact_ids: [...artifactIds] };
  return apiPost<CopyFromArenaResult>(
    chatId
      ? `/private/sessions/${encodeURIComponent(chatId)}/bridge/copy-from-arena`
      : '/private/sessions/from-arena',
    body,
    { idempotencyKey: uuidv7() },
  );
}

/**
 * "Copy to my chat" (ADR-041): an arena file into one of your private chats linked to that arena,
 * or a new chat linked to it. `chatId` (a drop on a chat) asks first when that chat is not linked
 * (it becomes linked for good) or is linked to another arena (only a new chat can take it). The
 * copy is yours: the chat and its history are never shared, and pushing it back updates the same
 * arena file.
 */
export function CopyToChatDialog({
  projectId,
  artifactIds,
  chatId,
  onClose,
  onCopied,
}: {
  projectId: string;
  artifactIds: string[];
  chatId?: string;
  onClose: () => void;
  onCopied: (result: CopyFromArenaResult) => void;
}) {
  const modal = useModal(onClose);
  const [arena, setArena] = useState<ArenaSummary | null>(null);
  const [chats, setChats] = useState<PrivateChat[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      apiGet<ArenaList>('/arenas', controller.signal),
      apiGet<PrivateChatList>('/private/sessions?limit=200', controller.signal),
    ]).then(
      ([arenas, list]) => {
        setArena(arenas.items.find((a) => a.id === projectId) ?? null);
        setChats(list.items);
      },
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load your chats.'));
      },
    );
    return () => controller.abort();
  }, [projectId]);

  const copy = async (target: string | null) => {
    setBusy(target ?? 'new');
    setError(null);
    try {
      const result = await copyArenaFiles(projectId, artifactIds, target);
      onCopied(result);
      modal.close();
    } catch (err) {
      setError(errorText(err, 'Could not copy. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  const arenaName = arena?.name ?? 'this arena';
  const target = chatId ? chats?.find((c) => c.id === chatId) : undefined;
  const linkedHere = (chats ?? []).filter((c) => c.bound_project?.id === projectId);
  const files = artifactIds.length === 1 ? 'this file' : `these ${artifactIds.length} files`;
  const newChat = (
    <button
      type="button"
      className="btn pri h-10 px-4"
      disabled={busy !== null}
      onClick={() => void copy(null)}
    >
      {busy === 'new' ? 'Copying…' : 'New private chat'}
    </button>
  );

  let body: ReactNode;
  if (!chats) {
    body = !error && <p className="text-[14px] text-faint">Loading…</p>;
  } else if (target && target.bound_project && target.bound_project.id !== projectId) {
    body = (
      <>
        <p className="text-[14px] text-muted">
          <span className="font-medium text-text">{target.title ?? 'New chat'}</span> is linked to{' '}
          {target.bound_project.name}. A chat works with one arena, so {files} from {arenaName} can
          only go into a new chat.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn h-10 px-4" onClick={modal.close}>
            Cancel
          </button>
          {newChat}
        </div>
      </>
    );
  } else if (target && !target.bound_project) {
    body = (
      <>
        <p className="text-[14px] text-muted">
          <span className="font-medium text-text">{target.title ?? 'New chat'}</span> is not linked
          to an arena yet. Copying {files} links it to {arenaName} for good: its AI can then read
          that arena. Nothing in the chat is shared unless you push a file.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button type="button" className="btn ghost h-10 px-3" onClick={modal.close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn h-10 px-4"
            disabled={busy !== null}
            onClick={() => void copy(null)}
          >
            {busy === 'new' ? 'Copying…' : 'New chat instead'}
          </button>
          <button
            type="button"
            className="btn pri h-10 px-4"
            disabled={busy !== null}
            onClick={() => void copy(target.id)}
          >
            {busy === target.id ? 'Copying…' : 'Copy and link'}
          </button>
        </div>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-[14px] text-muted">
          Your copy is private. Push it back to add your changes to the same file in {arenaName}.
        </p>
        <ul className="mt-4 max-h-[320px] space-y-2 overflow-y-auto">
          {linkedHere.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void copy(c.id)}
                className="card flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raise"
              >
                <span className="min-w-0 flex-1 truncate font-medium">{c.title ?? 'New chat'}</span>
                <span className="text-[13px] text-faint">
                  {busy === c.id ? 'Copying…' : 'Linked to arena'}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {linkedHere.length === 0 && (
          <p className="mt-3 text-[13px] text-faint">
            None of your chats is linked to {arenaName} yet.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn ghost h-10 px-3" onClick={modal.close}>
            Cancel
          </button>
          {newChat}
        </div>
      </>
    );
  }

  return (
    <dialog
      {...modal.props}
      aria-labelledby="copy-title"
      className="card m-auto w-[480px] max-w-[calc(100vw-32px)] p-0 text-text shadow-pop"
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
        <h2 id="copy-title" className="text-[20px] font-bold">
          Copy to my chat
        </h2>
        <button
          type="button"
          aria-label="Close"
          className="btn ghost h-9 w-9 shrink-0"
          onClick={modal.close}
        >
          <XIcon size={18} />
        </button>
      </div>
      <div className="px-6 pb-6 pt-1">
        {body}
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-bad">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}

/** Links a chat to one arena and brings its context (write-once). */
export async function bringContext(chatId: string, projectId: string): Promise<PrivateMessage> {
  return apiPost<PrivateMessage>(
    `/private/sessions/${encodeURIComponent(chatId)}/bridge/pull-context`,
    { include: ['project_brief', 'recent_messages', 'artifacts'], project_id: projectId },
    { idempotencyKey: uuidv7() },
  );
}

/** "Bring context from an Arena": pick one of your arenas. */
export function ArenaPicker({
  chatId,
  onClose,
  onLinked,
}: {
  chatId: string;
  onClose: () => void;
  onLinked: () => void;
}) {
  const modal = useModal(onClose);
  const [arenas, setArenas] = useState<ArenaSummary[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiGet<ArenaList>('/arenas', controller.signal).then(
      // Archived arenas are read-only: nothing to link a chat to.
      (list) => setArenas(list.items.filter((a) => !a.archived)),
      (err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err, 'Could not load your arenas.'));
      },
    );
    return () => controller.abort();
  }, []);

  const pick = async (arena: ArenaSummary) => {
    setBusy(arena.id);
    setError(null);
    try {
      await bringContext(chatId, arena.id);
      onLinked();
      modal.close();
    } catch (err) {
      setError(errorText(err, 'Could not bring context. Please try again.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <dialog
      {...modal.props}
      aria-labelledby="picker-title"
      className="card m-auto w-[480px] max-w-[calc(100vw-32px)] p-0 text-text shadow-pop"
    >
      <div className="flex items-start justify-between gap-4 px-6 pb-2 pt-6">
        <div>
          <h2 id="picker-title" className="text-[20px] font-bold">
            Bring context from an arena
          </h2>
          <p className="mt-1 text-[14px] text-muted">
            Your AI can then read that arena’s recent messages and files. This chat stays linked to
            it for good, and nothing in it is shared unless you push a file.
          </p>
        </div>
        <button
          type="button"
          aria-label="Close"
          className="btn ghost h-9 w-9 shrink-0"
          onClick={modal.close}
        >
          <XIcon size={18} />
        </button>
      </div>
      <div className="px-6 pb-6 pt-3">
        {!arenas && !error && <p className="text-[14px] text-faint">Loading…</p>}
        {arenas && arenas.length === 0 && (
          <p className="text-[14px] text-muted">You are not in any arena yet.</p>
        )}
        <ul className="space-y-2">
          {arenas?.map((arena) => (
            <li key={arena.id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void pick(arena)}
                className="card flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-raise"
              >
                <ArenaKey arenaKey={arena.key} />
                <span className="min-w-0 flex-1 truncate font-medium">{arena.name}</span>
                <span className="text-[13px] text-faint">
                  {busy === arena.id
                    ? 'Linking…'
                    : `${arena.member_count} ${arena.member_count === 1 ? 'member' : 'members'}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-[13px] text-bad">
            {error}
          </p>
        )}
      </div>
    </dialog>
  );
}
