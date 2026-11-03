import {
  CONFIDENT,
  type EdgeType,
  type Extraction,
  KEY_PREFIX,
  type MemoryEdge,
  type MemoryNode,
  type NodeAttrs,
  type NodeStatus,
  type NodeType,
  similarity,
  slug,
  STATUS_RULES,
} from './model.js';

// Merges one day's extraction into the arena's graph (ADR-045). Pure and deterministic: the AI only
// proposes; this code decides what is new, what is the same item said again, what replaces what,
// and what moved on. It never deletes: a replaced item is closed (status superseded, valid_to set)
// and keeps its history. Unit tested.
//
//   same item      an existing key the AI named (same type), else a title close enough to one of
//                  the same type (numbered types: 0.75 word overlap; named types: same slug or 0.85)
//   new item       numbered types get the arena's next key (D-004), named types a slug of the title
//   sources        each node and edge keeps the day's messages / events / files / PRs it came
//                  from; an item with no valid source is capped below CONFIDENT
//   uncertain      a new item below CONFIDENT is flagged needs_confirmation (shown, not asserted);
//                  a later confident mention with a source clears the flag
//   superseded     only between items of the same type (decision → decision, rule → rule)

export type SourceType = 'message' | 'event' | 'artifact_version' | 'pull_request';

export interface DaySource {
  type: SourceType;
  id: string;
}

export interface ResolveInput {
  /** The arena's local day, yyyy-mm-dd. */
  day: string;
  /** The day's end (ISO): when what was said that day became true. */
  at: string;
  nodes: readonly MemoryNode[];
  /** Live edges (valid_to null). */
  edges: readonly MemoryEdge[];
  extraction: Extraction;
  /** The day's citable sources by ref (M3, E2, F1, P1). */
  sources: ReadonlyMap<string, DaySource>;
  newId: () => string;
}

export interface NodeWrite {
  id: string;
  type: NodeType;
  key: string;
  title: string;
  summary: string;
  status: NodeStatus;
  attrs: NodeAttrs;
  firstSeenDay: string;
  lastSeenDay: string;
  /** Set when the item was closed this day (superseded). */
  validTo?: string;
}

export interface EdgeWrite {
  id: string;
  src: string;
  dst: string;
  type: EdgeType;
  confidence: number;
}

export interface SourceWrite {
  nodeId?: string;
  edgeId?: string;
  source: DaySource;
}

export type DeltaChange = 'new' | 'updated' | 'superseded' | 'status';

/** What changed in the memory that day: the narration's material. */
export interface DeltaItem {
  change: DeltaChange;
  type: NodeType;
  key: string;
  title: string;
  summary: string;
  status: NodeStatus;
  needsConfirmation: boolean;
  /** superseded: the item it replaced. */
  replaced?: { key: string; title: string };
}

export interface ResolvePlan {
  creates: NodeWrite[];
  /** Existing nodes, as they should now be (whole rows). */
  updates: NodeWrite[];
  edges: EdgeWrite[];
  sources: SourceWrite[];
  delta: DeltaItem[];
}

const NUMBERED_MATCH = 0.75;
const NAMED_MATCH = 0.85;
const SUPERSEDABLE: ReadonlySet<NodeType> = new Set(['Decision', 'Instruction', 'Requirement']);
const CLOSED: ReadonlySet<NodeStatus> = new Set(['superseded', 'dropped']);

const lower = (s: string) => s.trim().toLowerCase();

export function resolveDay(input: ResolveInput): ResolvePlan {
  const { day, extraction, sources } = input;
  // Working copies: later steps see earlier changes.
  const nodes = new Map<string, NodeWrite>(
    input.nodes.map((n) => [n.id, { ...n, attrs: { ...n.attrs } }]),
  );
  const created = new Set<string>();
  const changed = new Set<string>();
  const liveEdges = new Map<string, string>(
    input.edges.map((e) => [`${e.src}|${e.dst}|${e.type}`, e.id]),
  );
  const plan: ResolvePlan = { creates: [], updates: [], edges: [], sources: [], delta: [] };
  const deltaFor = new Map<string, DeltaItem>();
  const refs = new Map<string, string>(); // the AI's "n1" → node id

  const counters = new Map<string, number>();
  for (const n of nodes.values()) {
    const prefix = KEY_PREFIX[n.type];
    const m = prefix ? new RegExp(`^${prefix}-(\\d+)$`).exec(n.key) : null;
    if (prefix && m) counters.set(prefix, Math.max(counters.get(prefix) ?? 0, Number(m[1])));
  }
  const nextKey = (type: NodeType): string => {
    const prefix = KEY_PREFIX[type];
    if (!prefix) throw new Error('not numbered');
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}-${String(n).padStart(3, '0')}`;
  };

  const validSources = (list: readonly string[]): DaySource[] => {
    const out: DaySource[] = [];
    const seen = new Set<string>();
    for (const ref of list) {
      const s = sources.get(ref);
      if (s && !seen.has(ref)) {
        seen.add(ref);
        out.push(s);
      }
    }
    return out;
  };
  const addSources = (target: { nodeId?: string; edgeId?: string }, list: DaySource[]) => {
    for (const source of list) plan.sources.push({ ...target, source });
  };

  const sameType = (type: NodeType) => [...nodes.values()].filter((n) => n.type === type);

  /** The existing node an extracted one means, if any. */
  const match = (type: NodeType, key: string | null, title: string): NodeWrite | undefined => {
    if (key) {
      const byKey = sameType(type).find((n) => lower(n.key) === lower(key));
      if (byKey) return byKey;
    }
    const candidates = sameType(type).filter((n) => n.status !== 'dropped');
    if (!KEY_PREFIX[type]) {
      const exact = candidates.find((n) => n.key === slug(title));
      if (exact) return exact;
    }
    const threshold = KEY_PREFIX[type] ? NUMBERED_MATCH : NAMED_MATCH;
    let best: NodeWrite | undefined;
    let score = 0;
    for (const n of candidates) {
      const s = similarity(n.title, title);
      if (s >= threshold && s > score) {
        best = n;
        score = s;
      }
    }
    return best;
  };

  const touch = (node: NodeWrite, change: DeltaChange, replaced?: DeltaItem['replaced']) => {
    if (!created.has(node.id)) changed.add(node.id);
    const existing = deltaFor.get(node.id);
    // "new" wins over later changes of the same day; a status/supersede note wins over "updated".
    if (existing && (existing.change === 'new' || change === 'updated')) {
      Object.assign(existing, {
        title: node.title,
        summary: node.summary,
        status: node.status,
        needsConfirmation: !!node.attrs.needs_confirmation,
      });
      return;
    }
    const item: DeltaItem = {
      change,
      type: node.type,
      key: node.key,
      title: node.title,
      summary: node.summary,
      status: node.status,
      needsConfirmation: !!node.attrs.needs_confirmation,
      ...(replaced && { replaced }),
    };
    deltaFor.set(node.id, item);
  };

  // ---------------------------------------------------------------- nodes
  for (const x of extraction.nodes) {
    const cited = validSources(x.refs);
    const confidence = cited.length ? x.confidence : Math.min(x.confidence, CONFIDENT - 0.1);
    const found = match(x.type, x.key, x.title);
    if (found) {
      refs.set(x.ref, found.id);
      let updated = false;
      if (x.summary && x.summary !== found.summary) {
        found.summary = x.summary;
        updated = true;
      }
      if (x.why && x.why !== found.attrs.why) {
        found.attrs.why = x.why;
        updated = true;
      }
      if (x.roles.length) {
        const roles = [...new Set([...(found.attrs.roles ?? []), ...x.roles])].slice(0, 8);
        if (roles.length !== (found.attrs.roles ?? []).length) {
          found.attrs.roles = roles;
          updated = true;
        }
      }
      if (found.attrs.needs_confirmation && cited.length && confidence >= CONFIDENT) {
        delete found.attrs.needs_confirmation;
        updated = true;
      }
      const status = x.status;
      if (status && status !== found.status && STATUS_RULES[found.type].next.includes(status)) {
        found.status = status;
        touch(found, 'status');
      } else if (updated) {
        touch(found, 'updated');
      }
      if (found.lastSeenDay < day) found.lastSeenDay = day;
      if (!created.has(found.id)) changed.add(found.id);
      addSources({ nodeId: found.id }, cited);
      continue;
    }

    const rules = STATUS_RULES[x.type];
    let key = KEY_PREFIX[x.type] ? nextKey(x.type) : slug(x.title);
    if (!KEY_PREFIX[x.type]) {
      const taken = new Set(sameType(x.type).map((n) => n.key));
      for (let i = 2; taken.has(key); i += 1) key = `${slug(x.title)}-${i}`;
    }
    const attrs: NodeAttrs = {};
    if (x.why) attrs.why = x.why;
    if (x.roles.length) attrs.roles = [...new Set(x.roles)].slice(0, 8);
    if (confidence < CONFIDENT) attrs.needs_confirmation = true;
    const node: NodeWrite = {
      id: input.newId(),
      type: x.type,
      key,
      title: x.title,
      summary: x.summary,
      status:
        x.status && (x.status === rules.start || rules.next.includes(x.status))
          ? x.status
          : rules.start,
      attrs,
      firstSeenDay: day,
      lastSeenDay: day,
    };
    nodes.set(node.id, node);
    created.add(node.id);
    refs.set(x.ref, node.id);
    touch(node, 'new');
    addSources({ nodeId: node.id }, cited);
  }

  /** "n1" (this reply), "D-003" (any numbered key), "asha" (a named key, people first). */
  const endpoint = (handle: string): NodeWrite | undefined => {
    const byRef = refs.get(handle);
    if (byRef) return nodes.get(byRef);
    const all = [...nodes.values()];
    const keyed = all.filter((n) => lower(n.key) === lower(handle));
    if (keyed.length) return keyed.find((n) => n.type === 'Person') ?? keyed[0];
    const named = slug(handle);
    return all.find((n) => n.type === 'Person' && (n.key === named || slug(n.title) === named));
  };

  // ---------------------------------------------------------------- edges
  const addEdge = (
    src: NodeWrite,
    dst: NodeWrite,
    type: EdgeType,
    confidence: number,
    cited: DaySource[],
  ) => {
    if (src.id === dst.id) return;
    const k = `${src.id}|${dst.id}|${type}`;
    let id = liveEdges.get(k);
    if (!id) {
      id = input.newId();
      liveEdges.set(k, id);
      plan.edges.push({ id, src: src.id, dst: dst.id, type, confidence });
    }
    addSources({ edgeId: id }, cited);
  };

  for (const e of extraction.edges) {
    const src = endpoint(e.from);
    const dst = endpoint(e.to);
    if (!src || !dst || e.type === 'SUPERSEDES') continue;
    const cited = validSources(e.refs);
    const confidence = cited.length ? e.confidence : Math.min(e.confidence, CONFIDENT - 0.1);
    addEdge(src, dst, e.type, confidence, cited);
    // The decision table names who decided; a rule names who set it.
    if (
      (e.type === 'DECIDED_BY' || e.type === 'RAISED_BY') &&
      dst.type === 'Person' &&
      !src.attrs.by
    ) {
      src.attrs.by = dst.title;
      if (!created.has(src.id)) changed.add(src.id);
    }
  }

  // ---------------------------------------------------------------- replaced items
  for (const s of extraction.supersedes) {
    const next = endpoint(s.new);
    const old = endpoint(s.old);
    if (!next || !old || next.id === old.id || next.type !== old.type) continue;
    if (!SUPERSEDABLE.has(old.type) || CLOSED.has(old.status)) continue;
    old.status = 'superseded';
    old.validTo = input.at;
    touch(old, 'superseded');
    addEdge(next, old, 'SUPERSEDES', 1, validSources(s.refs));
    const item = deltaFor.get(next.id);
    if (item) item.replaced = { key: old.key, title: old.title };
    else touch(next, 'updated', { key: old.key, title: old.title });
  }

  // ---------------------------------------------------------------- moved on
  for (const c of extraction.status_changes) {
    const node = endpoint(c.key);
    if (!node || node.status === c.status || CLOSED.has(node.status)) continue;
    if (!STATUS_RULES[node.type].next.includes(c.status)) continue;
    node.status = c.status;
    if (node.lastSeenDay < day) node.lastSeenDay = day;
    touch(node, 'status');
    addSources({ nodeId: node.id }, validSources(c.refs));
  }

  for (const id of created) {
    const n = nodes.get(id);
    if (n) plan.creates.push(n);
  }
  for (const id of changed) {
    const n = nodes.get(id);
    if (n) plan.updates.push(n);
  }
  // Delta in a stable order: new first, then the rest, each by type then key.
  const order: Record<DeltaChange, number> = { new: 0, superseded: 1, status: 2, updated: 3 };
  plan.delta = [...deltaFor.values()].sort(
    (a, b) =>
      order[a.change] - order[b.change] ||
      a.type.localeCompare(b.type) ||
      a.key.localeCompare(b.key),
  );
  return plan;
}
