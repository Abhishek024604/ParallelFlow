import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Automatic layout for the AI's draw.io diagrams, applied when a `.drawio` draft is saved (the model
// places boxes by hand and small models place them badly). The passes are draw.io's own, from
// `@drawio/mcp`: ELK lays the whole diagram out ("flow"); libavoid keeps the boxes and re-routes the
// arrows around them ("route"). Both run fully offline: draw.io would download its layout code from
// its CDN and eval it, so the ELK bundle is a pinned copy in vendor/drawio-elk (checked by SHA-256
// before use) and the routing core is the copy shipped inside the package. Any failure saves the
// diagram unchanged. Diagram content is never logged.

export type DiagramLayout = 'flow' | 'route' | 'none';

/** SHA-256 of vendor/drawio-elk/drawio-elk.min.js (see vendor/drawio-elk/README.md to update). */
export const ELK_BUNDLE_SHA256 = '25847b1ded5d2fed2e175ec0d781d6e36b6d2971d29d3959c6aac70ddfedd394';

const ELK_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'vendor',
  'drawio-elk',
  'drawio-elk.min.js',
);

export const isDrawioName = (name: string): boolean => /\.drawio$/i.test(name.trim());

/** The model's choice; architecture-style "route" when it gives none. */
export function layoutOf(value: unknown): DiagramLayout {
  return value === 'flow' || value === 'none' ? value : 'route';
}

interface Passes {
  layoutXml(xml: string, options?: { direction?: string }): Promise<string>;
  routeXml(xml: string): Promise<string>;
}

let passes: Promise<Passes> | null = null;

function loadPasses(): Promise<Passes> {
  passes ??= (async () => {
    const sha = createHash('sha256').update(readFileSync(ELK_PATH)).digest('hex');
    if (sha !== ELK_BUNDLE_SHA256) throw new Error('drawio-elk bundle does not match its pin');
    const root = dirname(createRequire(import.meta.url).resolve('@drawio/mcp/package.json'));
    const cdn = (await import('@drawio/mcp/src/cdn-cache.js')) as {
      ROUTING_CORE: { url: string };
      ELK_BUNDLE: { url: string };
    };
    // A non-http(s) url is read from disk and never fetched (cdn-cache.js).
    cdn.ROUTING_CORE.url = join(root, 'vendor', 'libavoid', 'libavoid-routing.js');
    cdn.ELK_BUNDLE.url = ELK_PATH;
    const elk = (await import('@drawio/mcp/src/elk-pass.js')) as Pick<Passes, 'layoutXml'>;
    const route = (await import('@drawio/mcp/src/libavoid-pass.js')) as Pick<Passes, 'routeXml'>;
    return { layoutXml: elk.layoutXml, routeXml: route.routeXml };
  })();
  passes.catch(() => {
    passes = null;
  });
  return passes;
}

/** The laid-out XML, or the input unchanged (`laidOut: false`) when the layout could not run. */
export async function layoutDiagram(
  xml: string,
  layout: DiagramLayout,
): Promise<{ xml: string; laidOut: boolean }> {
  if (layout === 'none' || !/<(mxfile|mxGraphModel)[\s>]/.test(xml)) {
    return { xml, laidOut: false };
  }
  try {
    const p = await loadPasses();
    const out =
      layout === 'flow'
        ? await p.layoutXml(xml, { direction: 'horizontal' })
        : await p.routeXml(xml);
    return out ? { xml: out, laidOut: true } : { xml, laidOut: false };
  } catch {
    return { xml, laidOut: false };
  }
}
