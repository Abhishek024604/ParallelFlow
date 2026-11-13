import type { MemoryEdge, MemoryNode } from './model.js';

// STATE.md shared pieces (ADR-045): its marker, the paths of the graph and the pre-memory notes,
// day formatting, the nightly day rows, and docs/state/graph.json (the graph for machines: coding
// agents, tools). The playbook itself (STATE.md's layout) is rendered by playbook.ts. Pure; unit
// tested.

export const STORY_MARKER = '<!-- memory-story -->';
export const STATE_DIR = 'docs/state';
export const GRAPH_PATH = `${STATE_DIR}/graph.json`;
export const LEGACY_PATH = `${STATE_DIR}/legacy.md`;

export type ChapterStatus = 'pending' | 'done' | 'quiet' | 'failed';

export const isMemoryStory = (content: string | null | undefined): boolean =>
  !!content && content.includes(STORY_MARKER);

/** "14 Oct 2026". */
export function shortDay(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "14–18 Oct 2026", "30 Oct – 2 Nov 2026", "14 Oct 2026". */
export function dayRange(from: string, to: string): string {
  if (from === to) return shortDay(from);
  const [fy, fm] = from.split('-');
  const [ty, tm] = to.split('-');
  const a = new Date(`${from}T12:00:00Z`);
  const day = (d: Date) => String(d.getUTCDate());
  const month = (d: Date) => d.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  if (fy === ty && fm === tm) return `${day(a)}–${shortDay(to)}`;
  if (fy === ty) return `${day(a)} ${month(a)} – ${shortDay(to)}`;
  return `${shortDay(from)} – ${shortDay(to)}`;
}

function byKey(a: MemoryNode, b: MemoryNode): number {
  const n = (k: string) => Number(/-(\d+)$/.exec(k)?.[1] ?? 0);
  return n(a.key) - n(b.key) || a.key.localeCompare(b.key);
}

export interface GraphSource {
  nodeId: string | null;
  edgeId: string | null;
  type: string;
  id: string;
}

/** docs/state/graph.json: the graph by readable ids ("Decision:D-001"); sources are ids only. */
export function renderGraphJson(input: {
  arenaName: string;
  upTo: string | null;
  nodes: readonly MemoryNode[];
  edges: readonly MemoryEdge[];
  sources: readonly GraphSource[];
}): string {
  const name = new Map(input.nodes.map((n) => [n.id, `${n.type}:${n.key}`]));
  const edgeName = new Map<string, string>();
  const edges = input.edges
    .filter((e) => name.has(e.src) && name.has(e.dst))
    .map((e) => {
      edgeName.set(e.id, `${name.get(e.src)} ${e.type} ${name.get(e.dst)}`);
      return { from: name.get(e.src), type: e.type, to: name.get(e.dst), confidence: e.confidence };
    });
  const sources: Record<string, { type: string; id: string }[]> = {};
  for (const s of input.sources) {
    const owner = s.nodeId ? name.get(s.nodeId) : s.edgeId ? edgeName.get(s.edgeId) : undefined;
    if (!owner) continue;
    (sources[owner] ??= []).push({ type: s.type, id: s.id });
  }
  const nodes = [...input.nodes]
    .sort((a, b) => a.type.localeCompare(b.type) || byKey(a, b))
    .map((n) => ({
      id: `${n.type}:${n.key}`,
      type: n.type,
      key: n.key,
      title: n.title,
      summary: n.summary,
      status: n.status,
      first_seen: n.firstSeenDay,
      last_seen: n.lastSeenDay,
      ...(n.attrs.why && { why: n.attrs.why }),
      ...(n.attrs.by && { by: n.attrs.by }),
      ...(n.attrs.roles?.length && { roles: n.attrs.roles }),
      ...(n.attrs.needs_confirmation && { needs_confirmation: true }),
    }));
  return `${JSON.stringify(
    { arena: input.arenaName, up_to: input.upTo, version: 1, nodes, edges, sources },
    null,
    2,
  )}\n`;
}
