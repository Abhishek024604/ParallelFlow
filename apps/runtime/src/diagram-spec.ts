// A diagram spec → draw.io XML. The AI describes a diagram as boxes, groups and arrows (JSON, no
// coordinates) and saves it under a `.drawio` name; the runtime builds a real draw.io diagram from
// it with a fixed, clean style, and diagram-layout.ts places everything with ELK. Small models write
// a good spec far more reliably than hand-placed XML. Diagram content is never logged.

export const NODE_TYPES = [
  'service',
  'database',
  'queue',
  'cache',
  'storage',
  'user',
  'external',
  'decision',
  'start',
  'end',
  'document',
  'note',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export interface DiagramSpec {
  title?: string;
  /** Flow direction: "right" (left to right, the default) or "down". */
  direction?: 'right' | 'down';
  groups?: { id: string; label: string; parent?: string }[];
  nodes: { id: string; label: string; type?: NodeType; group?: string }[];
  edges?: { from: string; to: string; label?: string; dashed?: boolean }[];
}

export class DiagramSpecError extends Error {}

export const MAX_SPEC_NODES = 60;

const TEXT = 'fontColor=#0a0a0a;fontSize=13;fontFamily=Helvetica;';
const SHAPE: Record<NodeType, { style: string; w: number; h: number; grow: boolean }> = {
  service: {
    style: 'rounded=1;arcSize=14;fillColor=#ffffff;strokeColor=#1f1f1f;',
    w: 140,
    h: 60,
    grow: true,
  },
  database: {
    style:
      'shape=cylinder3;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#f4f4f5;strokeColor=#1f1f1f;',
    w: 110,
    h: 80,
    grow: true,
  },
  queue: {
    style:
      'shape=cylinder3;direction=south;boundedLbl=1;backgroundOutline=1;size=10;fillColor=#f4f4f5;strokeColor=#1f1f1f;',
    w: 150,
    h: 56,
    grow: true,
  },
  cache: {
    style: 'rounded=1;arcSize=14;fillColor=#f4f4f5;strokeColor=#1f1f1f;dashed=1;',
    w: 130,
    h: 56,
    grow: true,
  },
  storage: {
    style:
      'shape=folder;tabWidth=40;tabHeight=12;tabPosition=left;fillColor=#f4f4f5;strokeColor=#1f1f1f;',
    w: 130,
    h: 64,
    grow: true,
  },
  user: {
    style:
      'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;outlineConnect=0;fillColor=#ffffff;strokeColor=#1f1f1f;',
    w: 36,
    h: 64,
    grow: false,
  },
  external: {
    style: 'rounded=1;arcSize=14;fillColor=#ffffff;strokeColor=#6b6b74;dashed=1;fontColor=#52525b;',
    w: 140,
    h: 60,
    grow: true,
  },
  decision: {
    style: 'rhombus;fillColor=#ffffff;strokeColor=#1f1f1f;',
    w: 150,
    h: 90,
    grow: true,
  },
  start: {
    style: 'ellipse;fillColor=#0a0a0a;strokeColor=#0a0a0a;fontColor=#ffffff;',
    w: 110,
    h: 48,
    grow: true,
  },
  end: {
    style: 'ellipse;fillColor=#ffffff;strokeColor=#0a0a0a;strokeWidth=2;',
    w: 110,
    h: 48,
    grow: true,
  },
  document: {
    style: 'shape=document;boundedLbl=1;size=0.15;fillColor=#ffffff;strokeColor=#1f1f1f;',
    w: 130,
    h: 70,
    grow: true,
  },
  note: {
    style:
      'shape=note;size=14;fillColor=#fafaf9;strokeColor=#a3a3a3;fontColor=#52525b;align=left;spacingLeft=8;',
    w: 180,
    h: 70,
    grow: true,
  },
};
const GROUP_STYLE =
  'rounded=1;arcSize=4;container=1;collapsible=0;fillColor=#fafafa;strokeColor=#d4d4d8;dashed=1;verticalAlign=top;align=left;spacingLeft=10;spacingTop=6;fontStyle=1;fontColor=#52525b;fontSize=12;fontFamily=Helvetica;';
const EDGE_STYLE =
  'edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeColor=#52525b;fontColor=#52525b;fontSize=11;labelBackgroundColor=#ffffff;';

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;');

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** True when a `.drawio` draft's content is a spec (JSON), not draw.io XML. */
export const looksLikeSpec = (content: string): boolean => content.trimStart().startsWith('{');

/** Parses and checks a spec; the error message tells the AI what to fix. */
export function parseSpec(content: string): DiagramSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new DiagramSpecError('The diagram spec is not valid JSON.');
  }
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(o['nodes']) || o['nodes'].length === 0) {
    throw new DiagramSpecError('The diagram spec needs a non-empty "nodes" list.');
  }
  if (o['nodes'].length > MAX_SPEC_NODES) {
    throw new DiagramSpecError(`At most ${MAX_SPEC_NODES} nodes; split the diagram.`);
  }
  const ids = new Set<string>();
  const claim = (id: unknown, what: string): string => {
    if (typeof id !== 'string' || !ID.test(id)) {
      throw new DiagramSpecError(
        `Every ${what} needs an id: letters, digits, - or _ (got ${JSON.stringify(id)}).`,
      );
    }
    if (ids.has(id)) throw new DiagramSpecError(`The id "${id}" is used twice.`);
    ids.add(id);
    return id;
  };
  const groups = (Array.isArray(o['groups']) ? o['groups'] : []).map(
    (g: Record<string, unknown>) => ({
      id: claim(g?.['id'], 'group'),
      label: str(g?.['label'], 80) ?? String(g?.['id']),
      parent: str(g?.['parent'], 40),
    }),
  );
  const groupIds = new Set(groups.map((g) => g.id));
  for (const g of groups) {
    if (g.parent !== undefined && (!groupIds.has(g.parent) || g.parent === g.id)) {
      throw new DiagramSpecError(`Group "${g.id}" has an unknown parent "${g.parent}".`);
    }
  }
  const nodes = (o['nodes'] as Record<string, unknown>[]).map((n) => {
    const id = claim(n?.['id'], 'node');
    const type = str(n?.['type'], 20) ?? 'service';
    if (!(NODE_TYPES as readonly string[]).includes(type)) {
      throw new DiagramSpecError(
        `Node "${id}" has type "${type}"; use one of ${NODE_TYPES.join(', ')}.`,
      );
    }
    const group = str(n?.['group'], 40);
    if (group !== undefined && !groupIds.has(group)) {
      throw new DiagramSpecError(`Node "${id}" is in an unknown group "${group}".`);
    }
    return { id, label: str(n?.['label'], 120) ?? id, type: type as NodeType, group };
  });
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = (Array.isArray(o['edges']) ? o['edges'] : []).map((e: Record<string, unknown>) => {
    const end = (key: 'from' | 'to'): string => {
      const id = str(e?.[key], 40);
      if (id === undefined || !nodeIds.has(id)) {
        throw new DiagramSpecError(`An arrow points at "${id ?? ''}", which is not a node id.`);
      }
      return id;
    };
    return {
      from: end('from'),
      to: end('to'),
      label: str(e?.['label'], 60),
      dashed: e?.['dashed'] === true,
    };
  });
  // A group inside itself through its parents.
  for (const g of groups) {
    const seen = new Set<string>();
    for (let p: string | undefined = g.id; p; p = groups.find((x) => x.id === p)?.parent) {
      if (seen.has(p)) throw new DiagramSpecError(`Group "${g.id}" is nested inside itself.`);
      seen.add(p);
    }
  }
  return {
    title: str(o['title'], 120),
    direction: o['direction'] === 'down' ? 'down' : 'right',
    groups,
    nodes,
    edges,
  };
}

/** Unlaid-out draw.io XML for a checked spec (diagram-layout.ts places it). */
export function specToXml(spec: DiagramSpec): string {
  const groups = spec.groups ?? [];
  const parentOf = new Map<string, string>();
  for (const g of groups) parentOf.set(g.id, g.parent ?? '1');
  for (const n of spec.nodes) parentOf.set(n.id, n.group ?? '1');
  const chain = (id: string): string[] => {
    const out: string[] = [];
    for (let p = parentOf.get(id); p && p !== '1'; p = parentOf.get(p)) out.push(p);
    return [...out, '1'];
  };
  // An edge lives in the deepest group that holds both of its ends.
  const commonParent = (a: string, b: string) => {
    const up = new Set(chain(b));
    return chain(a).find((p) => up.has(p)) ?? '1';
  };

  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  // Parents before children: draw.io needs a container defined before the cells inside it.
  const depth = (id: string) => chain(id).length;
  for (const g of [...groups].sort((a, b) => depth(a.id) - depth(b.id))) {
    cells.push(
      `<mxCell id="${g.id}" value="${esc(g.label)}" style="${GROUP_STYLE}" vertex="1" parent="${parentOf.get(g.id)}"><mxGeometry x="0" y="0" width="200" height="120" as="geometry"/></mxCell>`,
    );
  }
  for (const n of spec.nodes) {
    const shape = SHAPE[n.type ?? 'service'];
    const longest = Math.max(...n.label.split('\n').map((l) => l.length));
    const w = shape.grow ? Math.min(240, Math.max(shape.w, longest * 7.5 + 32)) : shape.w;
    cells.push(
      `<mxCell id="${n.id}" value="${esc(n.label)}" style="${shape.style}whiteSpace=wrap;html=1;${TEXT}" vertex="1" parent="${parentOf.get(n.id)}"><mxGeometry x="0" y="0" width="${Math.round(w)}" height="${shape.h}" as="geometry"/></mxCell>`,
    );
  }
  (spec.edges ?? []).forEach((e, i) => {
    cells.push(
      `<mxCell id="edge-${i + 1}" value="${esc(e.label ?? '')}" style="${EDGE_STYLE}${e.dashed ? 'dashed=1;' : ''}" edge="1" parent="${commonParent(e.from, e.to)}" source="${e.from}" target="${e.to}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  });
  return `<mxGraphModel grid="0" page="0" background="#ffffff"><root>${cells.join('')}</root></mxGraphModel>`;
}

/** Adds the spec's title above the laid-out diagram. */
export function withTitle(xml: string, title: string | undefined): string {
  if (!title) return xml;
  const cell = `<mxCell id="diagram-title" value="${esc(title)}" style="text;html=1;align=left;verticalAlign=middle;fontSize=18;fontStyle=1;fontColor=#0a0a0a;fontFamily=Helvetica;" vertex="1" parent="1"><mxGeometry x="12" y="-44" width="${Math.min(900, title.length * 11 + 40)}" height="32" as="geometry"/></mxCell>`;
  const at = xml.lastIndexOf('</root>');
  return at < 0 ? xml : xml.slice(0, at) + cell + xml.slice(at);
}
