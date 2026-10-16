'use client';

import {
  type Artifact,
  ARTIFACT_MAX_CHARS,
  ARTIFACT_NAME_MAX_CHARS,
  formatBytes,
  uuidv7,
} from '@saras/contracts';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { editedAgo } from '../lib/files';
import { ArtifactViewer } from './artifact-viewer';
import { PushDialog } from './bridge-dialogs';
import { FileIcon, PlusIcon } from './icons';

// My files (Private, build step 6): your markdown files, yours only (no org, ADR-034). New file
// makes v1; editing makes a new version; Push to Arena copies one version into an arena.

const errorText = (err: unknown) =>
  err instanceof ProblemError
    ? (err.fieldErrors[0]?.message ?? err.detail)
    : 'Something went wrong. Please try again.';

export function MyFiles({ files }: { files: Artifact[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const made = await apiPost<Artifact>(
        '/artifacts',
        { scope: 'private', kind: 'document', name: name.trim(), content },
        { idempotencyKey: uuidv7() },
      );
      router.push(`/private/files/${made.id}`);
      router.refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[900px] px-8 py-8">
      <div className="flex items-center gap-3">
        <h1 className="text-[22px] font-bold text-text">My files</h1>
        <span className="text-[13px] text-faint">Only you can see these</span>
        {!creating && (
          <button
            type="button"
            className="btn pri ml-auto h-10 gap-2 px-4"
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
            New file
          </button>
        )}
      </div>

      {creating && (
        <form onSubmit={(e) => void create(e)} className="card mt-5 space-y-3 p-4">
          <label className="block">
            <span className="text-[13px] text-muted">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={ARTIFACT_NAME_MAX_CHARS}
              placeholder="goal.md"
              autoFocus
              required
              className="inp mt-1 h-10 w-full px-2.5 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-[13px] text-muted">Markdown</span>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={ARTIFACT_MAX_CHARS}
              rows={10}
              className="inp mt-1 w-full p-2.5 font-mono text-[14px]"
            />
          </label>
          {error && (
            <p role="alert" className="text-[13px] text-bad">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn pri h-10 px-4" disabled={busy || !name.trim()}>
              {busy ? 'Saving…' : 'Create file'}
            </button>
            <button
              type="button"
              className="btn ghost h-10 px-3"
              onClick={() => setCreating(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {files.length === 0 && !creating ? (
        <p className="mt-10 text-center text-[15px] text-faint">
          No files yet. Create one, or ask your AI to draft a goal.md in a chat.
        </p>
      ) : (
        <ul className="mt-5 divide-y divide-line">
          {files.map((f) => (
            <li key={f.id}>
              <Link
                href={`/private/files/${f.id}`}
                className="nav flex items-center gap-3 px-2 py-3"
              >
                <FileIcon />
                <span className="min-w-0 flex-1 truncate font-mono text-[15px] text-text">
                  {f.name}
                </span>
                <span className="chip px-1.5 py-0.5 text-[12px]">v{f.head_version_no}</span>
                <span className="w-[160px] text-right text-[13px] text-faint">
                  {formatBytes(f.size_bytes)} · {editedAgo(f.updated_at)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PrivateFileView({ fileId }: { fileId: string }) {
  const router = useRouter();
  const [push, setPush] = useState<{ artifact: Artifact; versionNo: number } | null>(null);
  const [notice, setNotice] = useState<{ text: string; href: string } | null>(null);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b border-line px-5 py-2 text-[13px]">
        <Link href="/private/files" className="text-muted hover:text-text">
          ← My files
        </Link>
        {notice && (
          <span role="status" className="text-ok">
            {notice.text}{' '}
            <Link href={notice.href} className="underline">
              Open the arena
            </Link>
          </span>
        )}
      </div>
      <ArtifactViewer
        apiBase={`/artifacts/${encodeURIComponent(fileId)}`}
        canEdit
        onPush={(artifact, versionNo) => setPush({ artifact, versionNo })}
        onChanged={() => router.refresh()}
      />
      {push && (
        <PushDialog
          artifact={push.artifact}
          versionNo={push.versionNo}
          onClose={() => setPush(null)}
          onPushed={(result, arena) => {
            setNotice({
              text: `Pushed to ${arena.name} as v${result.version_no}.`,
              href: `/arena/${arena.project_id}`,
            });
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
