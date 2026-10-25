'use client';

import { useEffect, useId, useState } from 'react';

// A ```mermaid block drawn as a diagram (the AI's default diagram format: Mermaid lays itself out).
// The library loads only when a diagram is on screen. It runs with securityLevel "strict" (labels
// are sanitised, no click handlers or HTML labels) and takes its colours from the brand tokens, so
// diagrams follow the light and dark themes. A block that does not parse shows its source.

/** The brand tokens as Mermaid theme variables (Mermaid needs real colours, not var()). */
function themeVariables(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const text = token('--text');
  const line = token('--line2') || token('--line');
  return {
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: '14px',
    background: token('--panel'),
    primaryColor: token('--raise'),
    primaryTextColor: text,
    primaryBorderColor: line,
    secondaryColor: token('--panel'),
    tertiaryColor: token('--panel'),
    lineColor: token('--muted'),
    textColor: text,
    mainBkg: token('--raise'),
    nodeBorder: line,
    clusterBkg: token('--panel'),
    clusterBorder: line,
    titleColor: text,
    edgeLabelBackground: token('--panel'),
    actorBkg: token('--raise'),
    actorBorder: line,
    actorTextColor: text,
    signalColor: text,
    signalTextColor: text,
    noteBkgColor: token('--raise'),
    noteTextColor: text,
    noteBorderColor: line,
  };
}

export function MermaidDiagram({ source }: { source: string }) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setSvg(null);
    setFailed(false);
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVariables(),
          flowchart: { htmlLabels: false, curve: 'basis' },
        });
        const out = await mermaid.render(id, source);
        if (live) setSvg(out.svg);
      } catch {
        // Mermaid leaves its error graphic in the body on a parse error.
        document.getElementById(`d${id}`)?.remove();
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [id, source]);

  if (failed) {
    return (
      <div className="space-y-2">
        <p role="status" className="text-[13px] text-muted">
          This diagram cannot be drawn. Its Mermaid source is below.
        </p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }
  if (svg === null) return <p className="text-[13px] text-faint">Drawing the diagram…</p>;
  return (
    <figure
      className="mermaid-diagram overflow-x-auto rounded border border-line bg-panel p-4"
      // Mermaid's own output in strict mode (DOMPurify-sanitised SVG).
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
