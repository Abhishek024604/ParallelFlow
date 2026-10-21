import { inflateRawSync } from 'node:zlib';
import { contentHash } from './markdown.js';
import type { ArchModel, ComponentKind } from './model.js';

// Diagrams from model.yaml, by code (the model never draws the HLD views by hand, so the picture
// and the model cannot disagree): context, containers, deployment and one per key flow, as
// draw.io XML (approved HLD/LLD diagrams) or Excalidraw JSON (whiteboard sketches).
//
// Cells carry the model's ids, so swa_diagram_sync can read an edited file back and report how it
// differs from the model instead of overwriting the architect's edits. A generated file records
// its own hash in the <diagram id>, so an edit (in draw.io or by hand) is detectable.

export type DiagramView = 'context' | 'containers' | 'deployment' | 'flow';

type BoxKind = ComponentKind | 'actor' | 'external' | 'system' | 'node' | 'participant';

interface Box {
  id: string;
  label: string;
  sub?: string;
  kind: BoxKind;
  x: number;
  y: number;
  w: number;
  h: number;
  parent?: string;
}

interface Line {
  id: string;
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
  /** Free points (sequence messages), instead of from/to cells. */
  points?: { x1: number; y1: number; x2: number; y2: number };
}

interface Picture {
  title: string;
  boxes: Box[];
  lines: Line[];
}

const COLS = 4;
const W = 180;
const H = 80;
const GAP_X = 70;
const GAP_Y = 90;

function row(
  items: { id: string; label: string; sub?: string; kind: BoxKind }[],
  y: number,
  h = H,
): Box[] {
  return items.map((it, i) => ({ ...it, x: 40 + i * (W + GAP_X), y, w: W, h }));
}

function grid(
  items: { id: string; label: string; sub?: string; kind: BoxKind }[],
  y: number,
): Box[] {
  return items.map((it, i) => ({
    ...it,
    x: 40 + (i % COLS) * (W + GAP_X),
    y: y + Math.floor(i / COLS) * (H + GAP_Y),
    w: W,
    h: H,
  }));
}

const bottomOf = (boxes: Box[], fallback: number) =>
  boxes.length ? Math.max(...boxes.map((b) => b.y + b.h)) : fallback;

/** The views a model has: context, containers, deployment (if any), one per flow. */
export function modelViews(model: ArchModel): { view: DiagramView; flow?: string; path: string }[] {
  return [
    { view: 'context', path: 'hld/context.drawio' },
    { view: 'containers', path: 'hld/containers.drawio' },
    ...(model.deployment.length
      ? [{ view: 'deployment' as const, path: 'hld/deployment.drawio' }]
      : []),
    ...model.flows.map((f) => ({
      view: 'flow' as const,
      flow: f.id,
      path: `hld/flows/${flowFile(f.id)}.drawio`,
    })),
  ];
}

export const flowFile = (id: string): string =>
  id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'flow';

/** The view a diagram path shows (for sync), or null. */
export function viewOfPath(
  model: ArchModel,
  path: string,
): { view: DiagramView; flow?: string } | null {
  const name = path.replace(/\.(drawio|excalidraw)$/, '').replace(/^hld\/(sketches\/)?/, '');
  if (name === 'context' || name === 'containers' || name === 'deployment') return { view: name };
  const flow = model.flows.find((f) => `flows/${flowFile(f.id)}` === name);
  return flow ? { view: 'flow', flow: flow.id } : null;
}

export function picture(model: ArchModel, view: DiagramView, flowId?: string): Picture {
  const actors = model.actors.map((a) => ({ id: a.id, label: a.name, kind: 'actor' as const }));
  const externals = model.externals.map((e) => ({
    id: e.id,
    label: e.name,
    sub: 'external system',
    kind: 'external' as const,
  }));
  const inSystem = new Set(model.components.map((c) => c.id));
  const relLines = (map: (id: string) => string, onlyOuter: boolean): Line[] => {
    const seen = new Set<string>();
    const out: Line[] = [];
    for (const r of model.relations) {
      const from = map(r.from);
      const to = map(r.to);
      if (from === to) continue;
      if (onlyOuter && inSystem.has(r.from) && inSystem.has(r.to)) continue;
      const key = `${from}>${to}>${r.label ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: `rel:${from}:${to}:${out.length + 1}`,
        from,
        to,
        ...(r.label && { label: r.label }),
        ...(r.kind === 'async' && { dashed: true }),
      });
    }
    return out;
  };

  if (view === 'context') {
    const top = row(actors, 40, 70);
    const system: Box = {
      id: 'SYSTEM',
      label: model.system.name,
      sub: 'the system',
      kind: 'system',
      x: 40,
      y: bottomOf(top, 0) + GAP_Y,
      w: W * 2,
      h: H + 20,
    };
    const bottom = row(externals, system.y + system.h + GAP_Y);
    return {
      title: `${model.system.name}: system context`,
      boxes: [...top, system, ...bottom],
      lines: relLines((id) => (inSystem.has(id) ? 'SYSTEM' : id), true),
    };
  }

  if (view === 'containers') {
    const top = row(actors, 40, 70);
    const middle = grid(
      model.components.map((c) => ({
        id: c.id,
        label: c.name,
        sub: `${c.id}${c.tech ? ` · ${c.tech}` : ''}`,
        kind: c.kind,
      })),
      bottomOf(top, 0) + GAP_Y,
    );
    const bottom = row(externals, bottomOf(middle, 0) + GAP_Y);
    return {
      title: `${model.system.name}: containers`,
      boxes: [...top, ...middle, ...bottom],
      lines: relLines((id) => id, false),
    };
  }

  if (view === 'deployment') {
    const boxes: Box[] = [];
    let x = 40;
    for (const node of model.deployment) {
      const inner = node.contains
        .map((id) => model.components.find((c) => c.id === id))
        .filter((c) => c !== undefined);
      const h = 60 + Math.max(1, inner.length) * (H + 20);
      boxes.push({
        id: node.id,
        label: node.name,
        ...(node.kind && { sub: node.kind }),
        kind: 'node',
        x,
        y: 40,
        w: W + 40,
        h,
      });
      inner.forEach((c, i) =>
        boxes.push({
          id: `${node.id}/${c.id}`,
          label: c.name,
          sub: c.id,
          kind: c.kind,
          x: 20,
          y: 50 + i * (H + 20),
          w: W,
          h: H,
          parent: node.id,
        }),
      );
      x += W + 40 + GAP_X;
    }
    return { title: `${model.system.name}: deployment`, boxes, lines: [] };
  }

  const flow = model.flows.find((f) => f.id === flowId);
  if (!flow) throw new Error(`there is no flow "${flowId ?? ''}" in model.yaml`);
  const names = new Map(
    [...model.actors, ...model.externals, ...model.components].map((n) => [n.id, n.name]),
  );
  const participants = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const lifeline = 80 + flow.steps.length * 50;
  const boxes: Box[] = participants.map((id, i) => ({
    id: `${flow.id}/${id}`,
    label: names.get(id) ?? id,
    sub: id,
    kind: 'participant',
    x: 40 + i * (W + 40),
    y: 40,
    w: W,
    h: lifeline,
  }));
  const centre = (id: string) => 40 + participants.indexOf(id) * (W + 40) + W / 2;
  const lines: Line[] = flow.steps.map((s, i) => ({
    id: `${flow.id}/step-${i + 1}`,
    from: `${flow.id}/${s.from}`,
    to: `${flow.id}/${s.to}`,
    label: `${i + 1}. ${s.label ?? ''}`.trim(),
    ...(s.kind === 'async' && { dashed: true }),
    points: { x1: centre(s.from), y1: 40 + 70 + i * 50, x2: centre(s.to), y2: 40 + 70 + i * 50 },
  }));
  return { title: `${model.system.name}: ${flow.name}`, boxes, lines };
}

// ---------------------------------------------------------------- draw.io

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xa;');

const html = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const STYLE: Record<BoxKind, string> = {
  service: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;',
  ui: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#e1d5e7;strokeColor=#9673a6;',
  gateway: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;',
  function: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  database:
    'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f8cecc;strokeColor=#b85450;',
  cache:
    'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#ffe6cc;strokeColor=#d79b00;',
  storage:
    'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;size=12;fillColor=#f5f5f5;strokeColor=#666666;',
  queue:
    'shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;fillColor=#fff2cc;strokeColor=#d6b656;',
  other: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#f5f5f5;strokeColor=#666666;',
  actor: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;',
  external: 'rounded=0;whiteSpace=wrap;html=1;dashed=1;fillColor=#f5f5f5;strokeColor=#666666;',
  system: 'rounded=1;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;fontStyle=1;',
  node: 'swimlane;whiteSpace=wrap;html=1;startSize=30;rounded=1;fillColor=#f5f5f5;strokeColor=#666666;',
  participant:
    'shape=umlLifeline;perimeter=lifelinePerimeter;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;outlineConnect=0;size=50;',
};

const ACTOR_SIZE = { w: 40, h: 70 };

const HASH_PLACEHOLDER = 'swa-0000000000000000';

/** The draw.io file for one view. The <diagram id> holds the hash of the file as generated. */
export function toDrawio(pic: Picture, view: string): string {
  const cells: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  cells.push(
    `<mxCell id="title" value="${esc(html(pic.title))}" style="text;html=1;fontSize=16;fontStyle=1;align=left;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="40" y="0" width="600" height="30" as="geometry"/></mxCell>`,
  );
  for (const b of pic.boxes) {
    const value = b.sub
      ? `<b>${html(b.label)}</b><br><font style="font-size:10px">${html(b.sub)}</font>`
      : `<b>${html(b.label)}</b>`;
    const size = b.kind === 'actor' ? ACTOR_SIZE : { w: b.w, h: b.h };
    const x = b.kind === 'actor' ? b.x + (b.w - ACTOR_SIZE.w) / 2 : b.x;
    cells.push(
      `<mxCell id="${esc(b.id)}" value="${esc(b.kind === 'actor' ? html(b.label) : value)}" style="${STYLE[b.kind]}" vertex="1" parent="${esc(b.parent ?? '1')}"><mxGeometry x="${x}" y="${b.y + 40}" width="${size.w}" height="${size.h}" as="geometry"/></mxCell>`,
    );
  }
  for (const l of pic.lines) {
    const style = `edgeStyle=${l.points ? 'none' : 'orthogonalEdgeStyle'};rounded=0;html=1;endArrow=block;${l.dashed ? 'dashed=1;' : ''}`;
    const ends = l.points ? '' : ` source="${esc(l.from)}" target="${esc(l.to)}"`;
    const geometry = l.points
      ? `<mxGeometry relative="1" as="geometry"><mxPoint x="${l.points.x1}" y="${l.points.y1 + 40}" as="sourcePoint"/><mxPoint x="${l.points.x2}" y="${l.points.y2 + 40}" as="targetPoint"/></mxGeometry>`
      : '<mxGeometry relative="1" as="geometry"/>';
    cells.push(
      `<mxCell id="${esc(l.id)}" value="${esc(html(l.label ?? ''))}" style="${style}" edge="1" parent="1"${ends}>${geometry}</mxCell>`,
    );
  }
  const xml = `<mxfile host="swa"><diagram id="${HASH_PLACEHOLDER}" name="${esc(view)}"><mxGraphModel grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0"><root>${cells.join('')}</root></mxGraphModel></diagram></mxfile>\n`;
  return xml.replace(HASH_PLACEHOLDER, `swa-${contentHash(xml)}`);
}

/** True when a .drawio file is exactly as SWA generated it (not edited since). */
export function generatedUntouched(xml: string): boolean {
  const m = /<diagram id="(swa-[0-9a-f]{16})"/.exec(xml);
  if (!m?.[1]) return false;
  return `swa-${contentHash(xml.replace(m[1], HASH_PLACEHOLDER))}` === m[1];
}

// ---------------------------------------------------------------- Excalidraw

let seed = 1;
const base = (id: string, type: string, x: number, y: number, w: number, h: number) => ({
  id,
  type,
  x,
  y,
  width: w,
  height: h,
  angle: 0,
  strokeColor: '#1e1e1e',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 2,
  strokeStyle: 'solid',
  roughness: 1,
  opacity: 100,
  groupIds: [] as string[],
  frameId: null,
  roundness: type === 'rectangle' ? { type: 3 } : null,
  seed: seed++,
  version: 1,
  versionNonce: seed++,
  isDeleted: false,
  boundElements: [] as { id: string; type: string }[],
  updated: 1,
  link: null,
  locked: false,
});

const FILL: Partial<Record<BoxKind, string>> = {
  service: '#a5d8ff',
  ui: '#d0bfff',
  gateway: '#b2f2bb',
  function: '#ffec99',
  database: '#ffc9c9',
  cache: '#ffd8a8',
  queue: '#ffec99',
  system: '#a5d8ff',
};

/** An Excalidraw sketch of the same picture (whiteboard use: intake and early HLD talks). */
export function toExcalidraw(pic: Picture): string {
  seed = 1;
  const elements: Record<string, unknown>[] = [];
  const shapes = new Map<string, ReturnType<typeof base>>();
  const text = (
    id: string,
    value: string,
    x: number,
    y: number,
    w: number,
    h: number,
    container: string | null,
    size = 16,
  ) => ({
    ...base(id, 'text', x, y, w, h),
    text: value,
    originalText: value,
    fontSize: size,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: container,
    lineHeight: 1.25,
    autoResize: true,
  });
  elements.push(text('title', pic.title, 40, 0, 600, 30, null, 20));
  for (const b of pic.boxes) {
    const shape = base(
      b.id,
      b.kind === 'actor' ? 'ellipse' : 'rectangle',
      b.x,
      b.y + 40,
      b.w,
      b.kind === 'actor' ? 60 : b.h,
    );
    if (FILL[b.kind]) shape.backgroundColor = FILL[b.kind] as string;
    if (b.kind === 'external') shape.strokeStyle = 'dashed';
    const label = b.sub ? `${b.label}\n${b.sub}` : b.label;
    const t = text(
      `${b.id}:label`,
      label,
      b.x + 10,
      b.y + 50,
      b.w - 20,
      40,
      b.kind === 'participant' || b.kind === 'node' ? null : b.id,
    );
    if (t.containerId) shape.boundElements.push({ id: t.id, type: 'text' });
    shapes.set(b.id, shape);
    elements.push(shape, t);
  }
  for (const l of pic.lines) {
    const a = shapes.get(l.from);
    const z = shapes.get(l.to);
    const p = l.points
      ? { x1: l.points.x1, y1: l.points.y1 + 40, x2: l.points.x2, y2: l.points.y2 + 40 }
      : a && z
        ? { x1: a.x + a.width / 2, y1: a.y + a.height, x2: z.x + z.width / 2, y2: z.y }
        : null;
    if (!p) continue;
    const arrow = {
      ...base(l.id, 'arrow', p.x1, p.y1, Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1)),
      points: [
        [0, 0],
        [p.x2 - p.x1, p.y2 - p.y1],
      ],
      startBinding: !l.points && a ? { elementId: a.id, focus: 0, gap: 4 } : null,
      endBinding: !l.points && z ? { elementId: z.id, focus: 0, gap: 4 } : null,
      startArrowhead: null,
      endArrowhead: 'arrow',
      strokeStyle: l.dashed ? 'dashed' : 'solid',
    };
    if (!l.points) {
      a?.boundElements.push({ id: l.id, type: 'arrow' });
      z?.boundElements.push({ id: l.id, type: 'arrow' });
    }
    elements.push(arrow);
    if (l.label) {
      const t = text(
        `${l.id}:label`,
        l.label,
        (p.x1 + p.x2) / 2 - 60,
        (p.y1 + p.y2) / 2 - 10,
        120,
        20,
        l.id,
        12,
      );
      arrow.boundElements.push({ id: t.id, type: 'text' });
      elements.push(t);
    }
  }
  return `${JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'saras-swa',
      elements,
      appState: { viewBackgroundColor: '#ffffff', gridSize: null },
      files: {},
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------- reading draw.io back

export interface DrawioCell {
  id: string;
  label: string;
  vertex: boolean;
  source?: string;
  target?: string;
}

const unesc = (s: string): string =>
  s
    .replace(/&#xa;|&#10;/gi, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** Visible text of a label: HTML stripped, first line (the name). */
const labelName = (value: string): string =>
  unesc(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .split('\n')[0]
    ?.trim() ?? '';

/** The cells of the first page (plain or compressed draw.io files). */
export function readDrawio(xml: string): DrawioCell[] {
  let graph = xml;
  if (!/<mxGraphModel/.test(xml)) {
    const packed = /<diagram[^>]*>([^<]+)<\/diagram>/.exec(xml)?.[1]?.trim();
    if (!packed) throw new Error('no diagram in the file');
    graph = decodeURIComponent(inflateRawSync(Buffer.from(packed, 'base64')).toString('utf8'));
  }
  const cells: DrawioCell[] = [];
  for (const m of graph.matchAll(/<mxCell\b([^>]*?)\/?>/g)) {
    const attrs = new Map<string, string>();
    for (const a of (m[1] ?? '').matchAll(/([\w:-]+)="([^"]*)"/g))
      attrs.set(a[1] as string, a[2] as string);
    const id = attrs.get('id');
    if (!id || id === '0' || id === '1') continue;
    const vertex = attrs.get('vertex') === '1';
    if (!vertex && attrs.get('edge') !== '1') continue;
    // A label draw.io keeps as a child of an edge is part of that edge, not a shape.
    if (vertex && /(^|;)edgeLabel(;|$)/.test(attrs.get('style') ?? '')) continue;
    const source = attrs.get('source');
    const target = attrs.get('target');
    cells.push({
      id: unesc(id),
      label: labelName(attrs.get('value') ?? ''),
      vertex,
      ...(source && { source: unesc(source) }),
      ...(target && { target: unesc(target) }),
    });
  }
  return cells;
}

/**
 * How an edited draw.io file differs from the model's picture of the same view. Never changes
 * either: the architect decides whether model.yaml or the diagram is right.
 */
export function diagramDiff(pic: Picture, xml: string): string[] {
  const cells = readDrawio(xml);
  const out: string[] = [];
  const byId = new Map(cells.map((c) => [c.id, c]));
  const expected = new Set(pic.boxes.map((b) => b.id));
  for (const b of pic.boxes) {
    const cell = byId.get(b.id);
    if (!cell?.vertex) out.push(`missing from the diagram: ${b.id} "${b.label}"`);
    else if (cell.label && cell.label !== b.label) {
      out.push(`renamed in the diagram: ${b.id} is "${cell.label}", the model says "${b.label}"`);
    }
  }
  for (const c of cells) {
    if (!c.vertex || expected.has(c.id) || c.id === 'title' || !c.label) continue;
    out.push(`added in the diagram, not in the model: "${c.label}"`);
  }
  const pair = (from: string, to: string) => `${from} → ${to}`;
  const want = new Set(pic.lines.filter((l) => !l.points).map((l) => pair(l.from, l.to)));
  const have = new Set(
    cells
      .filter((c) => !c.vertex && c.source && c.target)
      .map((c) => pair(c.source as string, c.target as string)),
  );
  for (const w of want) if (!have.has(w)) out.push(`connection missing from the diagram: ${w}`);
  for (const h of have)
    if (!want.has(h)) out.push(`connection added in the diagram, not in the model: ${h}`);
  return out;
}
