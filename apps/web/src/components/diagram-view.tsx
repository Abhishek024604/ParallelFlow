'use client';

import { useEffect, useState } from 'react';
import { drawioLinks, isDrawioName, looksLikeDrawio } from '../lib/drawio';
import { MarkdownView } from './markdown';

// A .drawio document (the AI's diagrams, build of the draw.io connector): draw.io's read-only viewer
// in a sandboxed frame, and "Open in draw.io" in a new tab. The diagram travels in the link's
// #fragment only (lib/drawio.ts). Saving edits back from draw.io is not supported yet: people
// download the file from draw.io and upload it again.

export function DiagramView({ name, xml }: { name: string; xml: string }) {
  const [links, setLinks] = useState<{ viewer: string; editor: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setLinks(null);
    setFailed(false);
    drawioLinks(xml).then(
      (l) => live && setLinks(l),
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
  return (
    <div className="flex h-full min-h-[420px] flex-col gap-3">
      <div className="flex items-center gap-2">
        <p className="text-[13px] text-faint">Diagram · read-only preview</p>
        {links && (
          <a
            href={links.editor}
            target="_blank"
            rel="noopener noreferrer"
            className="btn ml-auto h-9 px-3 text-[14px]"
          >
            Open in draw.io
          </a>
        )}
      </div>
      {links ? (
        <iframe
          title={`Diagram: ${name}`}
          src={links.viewer}
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          className="min-h-[380px] w-full flex-1 rounded border border-line bg-panel"
        />
      ) : (
        <p className="text-[14px] text-faint">Loading the diagram…</p>
      )}
    </div>
  );
}

/** A document's body: a draw.io diagram, or sanitised Markdown. */
export function DocumentBody({ name, text }: { name: string; text: string }) {
  return isDrawioName(name) ? <DiagramView name={name} xml={text} /> : <MarkdownView text={text} />;
}
