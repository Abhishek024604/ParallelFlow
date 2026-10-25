'use client';

import { useEffect, useRef, useState } from 'react';

// The draw.io editor inside ParallelFlow: a full-window <dialog> with draw.io's embed mode in a
// sandboxed frame, driven over postMessage (draw.io's JSON protocol). The diagram is handed to the
// frame and comes back on Save; draw.io edits it in the browser and never uploads it. Messages are
// accepted only from the frame itself on draw.io's origin. Saving makes a new version of the file.

export const DRAWIO_EMBED_ORIGIN = 'https://embed.diagrams.net';
const EMBED_URL = `${DRAWIO_EMBED_ORIGIN}/?embed=1&proto=json&configure=1&spin=1&saveAndExit=1&noExitBtn=0&libraries=1&lang=en`;

type EditorMessage =
  | { event: 'configure' }
  | { event: 'init' }
  | { event: 'save'; xml: string; exit?: boolean }
  | { event: 'exit'; modified?: boolean };

export function DiagramEditor({
  name,
  xml,
  onSave,
  onClose,
}: {
  name: string;
  xml: string;
  /** Saves the edited XML as a new version; throws with a message the editor shows. */
  onSave: (xml: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The latest props, for the message handler registered once.
  const latest = useRef({ xml, onSave, onClose });
  latest.current = { xml, onSave, onClose };

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    const post = (msg: Record<string, unknown>) =>
      frame.current?.contentWindow?.postMessage(JSON.stringify(msg), DRAWIO_EMBED_ORIGIN);
    const close = () => dialog.current?.close();

    const onMessage = async (e: MessageEvent) => {
      if (e.origin !== DRAWIO_EMBED_ORIGIN || e.source !== frame.current?.contentWindow) return;
      if (typeof e.data !== 'string') return;
      let msg: EditorMessage;
      try {
        msg = JSON.parse(e.data) as EditorMessage;
      } catch {
        return;
      }
      if (msg.event === 'configure') {
        // Plain (uncompressed) XML, so the AI and people can read the saved file.
        post({ action: 'configure', config: { compressXml: false } });
      } else if (msg.event === 'init') {
        post({ action: 'load', xml: latest.current.xml, title: name, autosave: 0 });
      } else if (msg.event === 'save') {
        setError(null);
        setStatus('Saving…');
        post({ action: 'spinner', show: true, messageKey: 'saving' });
        try {
          await latest.current.onSave(msg.xml);
          post({ action: 'status', message: 'Saved as a new version', modified: false });
          setStatus('Saved as a new version');
          if (msg.exit) close();
        } catch (err) {
          setStatus(null);
          setError(err instanceof Error ? err.message : 'Could not save. Please try again.');
        } finally {
          post({ action: 'spinner', show: false });
        }
      } else if (msg.event === 'exit') {
        close();
      }
    };
    const listener = (e: MessageEvent) => void onMessage(e);
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [name]);

  return (
    <dialog
      ref={dialog}
      onClose={() => latest.current.onClose()}
      // Esc belongs to draw.io (it closes its own menus); the editor's Exit asks about unsaved work.
      onCancel={(e) => e.preventDefault()}
      aria-label={`Edit diagram ${name}`}
      className="m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-panel p-0 text-text"
    >
      <header className="flex items-center gap-3 border-b border-line px-5 py-2.5">
        <h2 className="min-w-0 flex-1 truncate font-mono text-[15px] text-text">{name}</h2>
        {error ? (
          <p role="alert" className="text-[13px] text-bad">
            {error}
          </p>
        ) : (
          status && (
            <p role="status" className="text-[13px] text-faint">
              {status}
            </p>
          )
        )}
        <span className="hidden text-[12px] text-faint sm:inline">
          Save makes a new version · Exit closes the editor
        </span>
      </header>
      <iframe
        ref={frame}
        title={`Diagram editor: ${name}`}
        src={EMBED_URL}
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-forms"
        referrerPolicy="no-referrer"
        className="min-h-0 w-full flex-1 border-0"
      />
    </dialog>
  );
}
