'use client';

import { type ExtHandoff, vscodeStartLink } from '@parallelflow/contracts';
import { useEffect, useRef, useState } from 'react';
import { apiPost, ProblemError } from '../lib/api-browser';
import { CodeIcon } from './icons';

// "Build in VS Code" (arena Overview): one click opens VS Code on this arena. The API makes a
// sign-in code already approved for you (single use, 10 minutes); the vscode:// link hands it to
// the ParallelFlow extension, which signs in, clones the arena's repository into
// ~/ParallelFlow/<arena>, opens the folder and asks which story to build. When VS Code does not
// take the link (the extension is not installed yet), the page says how to install it.

/** The packaged extension, served by the web app (apps/vscode `pnpm package`). */
export const VSIX_PATH = '/downloads/parallelflow.vsix';
const NO_HANDLER_MS = 2500;

export function BuildInVscode({ arenaId }: { arenaId: string }) {
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setHelp(false);
    try {
      const handoff = await apiPost<ExtHandoff>('/ext/handoff');
      // If VS Code takes the link, this window loses focus; if nothing happens, help shows.
      const left = () => clearTimeout(timer.current);
      window.addEventListener('blur', left, { once: true });
      timer.current = setTimeout(() => {
        window.removeEventListener('blur', left);
        setHelp(true);
      }, NO_HANDLER_MS);
      window.location.href = vscodeStartLink({
        arenaId,
        code: handoff.device_code,
        web: window.location.origin,
      });
    } catch (err) {
      setError(err instanceof ProblemError ? err.detail : 'Could not open VS Code. Try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="label">Build</h2>
      <p className="mt-2 text-[13px] text-muted">
        Open this arena in VS Code: it gets the repo, sets up the folder and asks which story to
        build with your AI.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn pri h-9 gap-2 px-3"
          disabled={busy}
          onClick={() => void open()}
        >
          <CodeIcon size={16} />
          {busy ? 'Opening…' : 'Build in VS Code'}
        </button>
        <a className="btn ghost h-9 px-3 text-[13px]" href={VSIX_PATH} download>
          Get the extension
        </a>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {error}
        </p>
      )}
      {help && (
        <div role="status" className="card mt-3 space-y-1.5 p-3 text-[13px] text-text">
          <p className="font-medium">VS Code did not open?</p>
          <ol className="list-decimal space-y-1 pl-5 text-muted">
            <li>
              <a className="underline" href={VSIX_PATH} download>
                Download the ParallelFlow extension
              </a>{' '}
              (once).
            </li>
            <li>In VS Code: Extensions › ⋯ › Install from VSIX…, and pick the file.</li>
            <li>Press Build in VS Code again.</li>
          </ol>
        </div>
      )}
    </section>
  );
}
