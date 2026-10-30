'use client';

import {
  type ArenaList,
  type ArenaSummary,
  type Artifact,
  type ArtifactList,
  type CopyFromArenaResult,
  type PrivateChat,
  uuidv7,
} from '@parallelflow/contracts';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, ProblemError } from '../lib/api-browser';
import {
  ANNOUNCE_EVENT,
  announce,
  COPY_TO_CHAT_EVENT,
  type CopyToChatRequest,
  PUSH_FILE_EVENT,
  PUSH_FOLDER_EVENT,
  type PushFileRequest,
  type PushFolderRequest,
} from '../lib/file-drag';
import { FILES_CHANGED_EVENT } from './artifact-viewer';
import { copyArenaFiles, CopyToChatDialog, PushDialog, PushFolderDialog } from './bridge-dialogs';
import { findFolder, folderFiles } from './doc-tree';

// The bridge's dialogs for drag and drop and menus anywhere in the app (ADR-041), mounted once
// with the top bar: "Copy to my chat" (an arena file into a private chat) and Push to Arena (a
// private file dropped on an arena). Also the app's polite live region for announce().

const errorText = (err: unknown) =>
  err instanceof ProblemError ? err.detail : 'Something went wrong. Please try again.';

export function chatFileLink(chatId: string, fileId?: string): string {
  const query = fileId ? `?file=${encodeURIComponent(fileId)}` : '';
  return `/private/${encodeURIComponent(chatId)}${query}`;
}

export function BridgeHost() {
  const router = useRouter();
  const [message, setMessage] = useState('');
  const [copy, setCopy] = useState<CopyToChatRequest | null>(null);
  const [push, setPush] = useState<{ artifact: Artifact; projectId?: string } | null>(null);
  const [pushFolder, setPushFolder] = useState<{
    chatId: string;
    folder: string;
    files: Artifact[];
    projectId?: string;
  } | null>(null);

  // After a copy: say so, refresh the lists and open the chat with its first copied file.
  const copied = useCallback(
    (result: CopyFromArenaResult) => {
      const n = result.copies.length;
      announce(n === 1 ? 'Copied 1 file to your chat.' : `Copied ${n} files to your chat.`);
      window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
      router.push(chatFileLink(result.chat_id, result.copies[0]?.artifact_id));
      router.refresh();
    },
    [router],
  );

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const text = (event as CustomEvent<string>).detail;
      // Cleared first, so the same words twice are read twice.
      setMessage('');
      window.setTimeout(() => setMessage(text), 50);
    };
    const onCopy = (event: Event) => {
      const request = (event as CustomEvent<CopyToChatRequest>).detail;
      void (async () => {
        // Dropped on a chat already linked to that arena: copy at once, nothing to ask.
        if (request.chatId) {
          try {
            const chat = await apiGet<PrivateChat>(
              `/private/sessions/${encodeURIComponent(request.chatId)}`,
            );
            if (chat.bound_project?.id === request.projectId) {
              copied(await copyArenaFiles(request.projectId, request.artifactIds, chat.id));
              return;
            }
          } catch (err) {
            announce(errorText(err));
            return;
          }
        }
        setCopy(request);
      })();
    };
    const onPush = (event: Event) => {
      const request = (event as CustomEvent<PushFileRequest>).detail;
      apiGet<Artifact>(`/artifacts/${encodeURIComponent(request.artifactId)}`).then(
        (artifact) =>
          setPush({ artifact, ...(request.projectId && { projectId: request.projectId }) }),
        (err: unknown) => announce(errorText(err)),
      );
    };
    // A folder of a chat: its files now (the panel's tree), then the Push folder dialog.
    const onPushFolder = (event: Event) => {
      const request = (event as CustomEvent<PushFolderRequest>).detail;
      apiGet<ArtifactList>(
        `/artifacts?scope=private&private_session_id=${encodeURIComponent(request.chatId)}`,
      ).then(
        (list) => {
          const folder = findFolder(list.items, request.path);
          const files = folder ? folderFiles(folder) : [];
          if (!folder || files.length === 0) {
            announce('This folder has no files to push.');
            return;
          }
          setPushFolder({
            chatId: request.chatId,
            folder: folder.name,
            files,
            ...(request.projectId && { projectId: request.projectId }),
          });
        },
        (err: unknown) => announce(errorText(err)),
      );
    };
    window.addEventListener(ANNOUNCE_EVENT, onAnnounce);
    window.addEventListener(COPY_TO_CHAT_EVENT, onCopy);
    window.addEventListener(PUSH_FILE_EVENT, onPush);
    window.addEventListener(PUSH_FOLDER_EVENT, onPushFolder);
    return () => {
      window.removeEventListener(ANNOUNCE_EVENT, onAnnounce);
      window.removeEventListener(COPY_TO_CHAT_EVENT, onCopy);
      window.removeEventListener(PUSH_FILE_EVENT, onPush);
      window.removeEventListener(PUSH_FOLDER_EVENT, onPushFolder);
    };
  }, [copied]);

  return (
    <>
      <p aria-live="polite" role="status" className="sr-only">
        {message}
      </p>
      {copy && (
        <CopyToChatDialog
          projectId={copy.projectId}
          artifactIds={copy.artifactIds}
          {...(copy.chatId && { chatId: copy.chatId })}
          onClose={() => setCopy(null)}
          onCopied={copied}
        />
      )}
      {push && (
        <PushDialog
          artifact={push.artifact}
          {...(push.projectId && { initialProjectId: push.projectId })}
          onClose={() => setPush(null)}
          onPushed={(result, arena) => {
            announce(`Pushed to ${arena.name} as v${result.version_no}.`);
            window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
            router.refresh();
          }}
        />
      )}
      {pushFolder && (
        <PushFolderDialog
          chatId={pushFolder.chatId}
          folder={pushFolder.folder}
          files={pushFolder.files}
          {...(pushFolder.projectId && { initialProjectId: pushFolder.projectId })}
          onClose={() => setPushFolder(null)}
          onPushed={(result, arena) => {
            const n = result.counts.new + result.counts.new_version;
            announce(
              `Pushed ${pushFolder.folder} to ${arena.name}: ${n} ${n === 1 ? 'file' : 'files'}.`,
            );
            window.dispatchEvent(new Event(FILES_CHANGED_EVENT));
            router.refresh();
          }}
        />
      )}
    </>
  );
}

/**
 * The stage handoff (ADR-041), from the Inbox: "<Stage> approved: start <Next>". Opens a new
 * private chat linked to the arena with the files approved at that gate copied in.
 */
export function HandoffCard({ projectId, approvalId }: { projectId: string; approvalId: string }) {
  const router = useRouter();
  const [arena, setArena] = useState<ArenaSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    apiGet<ArenaList>('/arenas', controller.signal).then(
      (list) => setArena(list.items.find((a) => a.id === projectId) ?? null),
      () => undefined,
    );
    return () => controller.abort();
  }, [projectId]);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await apiPost<CopyFromArenaResult>(
        '/private/sessions/from-arena',
        { project_id: projectId, approval_id: approvalId },
        { idempotencyKey: uuidv7() },
      );
      announce('Opened a private chat with the approved files.');
      router.push(chatFileLink(result.chat_id, result.copies[0]?.artifact_id));
      router.refresh();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const stage = arena?.stage ? arena.stage.charAt(0) + arena.stage.slice(1).toLowerCase() : null;
  return (
    <section aria-labelledby="handoff-title" className="card w-full p-5">
      <h2 id="handoff-title" className="text-[17px] font-semibold text-text">
        {stage ? `Start ${stage}` : 'A stage was approved'}
        {arena ? ` · ${arena.name}` : ''}
      </h2>
      <p className="mt-1 text-[14px] text-muted">
        Work on the approved files in a private chat linked to this arena. Your chat stays private;
        push a file back when it is ready.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn pri mt-4 h-10 px-4"
        disabled={busy}
        onClick={() => void open()}
      >
        {busy ? 'Opening…' : 'Open in a private chat'}
      </button>
    </section>
  );
}
