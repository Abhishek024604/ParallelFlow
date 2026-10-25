'use client';

import { useEffect, useState } from 'react';
import { drawioViewerUrl, isDrawioName, looksLikeDrawio } from '../lib/drawio';
import { MarkdownView } from './markdown';

// A .drawio document (the AI's diagrams and people's): draw.io's read-only viewer in a sandboxed
// frame. The diagram travels in the link's #fragment only (lib/drawio.ts). People with edit rights
// edit it inside ParallelFlow from the file's "Edit diagram" (diagram-editor.tsx).

export function DiagramView({ name, xml }: { name: string; xml: string }) {
  const [viewer, setViewer] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setViewer(null);
    setFailed(false);
    drawioViewerUrl(xml).then(
      (url) => live && setViewer(url),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [xml]);

  if (failed || !looksLikeDrawio(xml)) {
    return (
      <div className="space-y-2">
        <p role="status" className="text-[14px] text-muted">
          This diagram cannot be shown here. Its draw.io XML is below.
        </p>
        <pre className="whitespace-pre-wrap break-words font-mono text-[13px]">{xml}</pre>
      </div>
    );
  }
  return viewer ? (
    <iframe
      title={`Diagram: ${name}`}
      src={viewer}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className="h-full min-h-[420px] w-full rounded border border-line bg-panel"
    />
  ) : (
    <p className="text-[14px] text-faint">Loading the diagram…</p>
  );
}

/** A document's body: a draw.io diagram, or sanitised Markdown. */
export function DocumentBody({ name, text }: { name: string; text: string }) {
  return isDrawioName(name) ? <DiagramView name={name} xml={text} /> : <MarkdownView text={text} />;
}
