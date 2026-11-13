import { z } from 'zod';

// The arena's memory graph (ADR-045): node and edge types, statuses, keys, and the strict JSON the
// arena's AI returns when it reads a day (the extract-memory skill). Pure; unit tested.

export const NODE_TYPES = [
  'Person',
  'Role',
  'Decision',
  'Instruction',
  'Requirement',
  'Question',
  'Risk',
  'ActionItem',
  'Artifact',
  'Story',
  'Component',
  'Milestone',
  'Topic',
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const EDGE_TYPES = [
  'DECIDED_BY',
  'RAISED_BY',
  'OWNS',
  'ASSIGNED_TO',
  'ABOUT',
  'AFFECTS',
  'SUPERSEDES',
  'ANSWERS',
  'BLOCKS',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'HAPPENED_ON',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export const NODE_STATUSES = [
  'active',
  'open',
  'resolved',
  'done',
  'superseded',
  'dropped',
] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * Numbered types get a stable key per arena ("D-003"), the rest a slug of their title ("asha",
 * "checkout-service"). Numbered keys are what the story and the AI cite.
 */
export const KEY_PREFIX: Partial<Record<NodeType, string>> = {
  Decision: 'D',
  Instruction: 'RULE',
  Requirement: 'REQ',
  Question: 'Q',
  Risk: 'RISK',
  ActionItem: 'A',
};

/** Where a type starts, and where it may move (anything else is ignored). */
export const STATUS_RULES: Record<NodeType, { start: NodeStatus; next: readonly NodeStatus[] }> = {
  Person: { start: 'active', next: [] },
  Role: { start: 'active', next: [] },
  Decision: { start: 'active', next: ['superseded', 'dropped'] },
  Instruction: { start: 'active', next: ['superseded', 'dropped'] },
  Requirement: { start: 'active', next: ['superseded', 'dropped', 'done'] },
  Question: { start: 'open', next: ['resolved', 'dropped'] },
  Risk: { start: 'open', next: ['resolved', 'dropped'] },
  ActionItem: { start: 'open', next: ['done', 'dropped'] },
  Artifact: { start: 'active', next: [] },
  Story: { start: 'open', next: ['done', 'dropped'] },
  Component: { start: 'active', next: [] },
  Milestone: { start: 'active', next: ['done'] },
  Topic: { start: 'active', next: [] },
};

/** Below this, a new item is listed under "Needs confirmation" instead of stated as fact. */
export const CONFIDENT = 0.6;

/** One node of the graph as the resolver and the story see it. */
export interface MemoryNode {
  id: string;
  type: NodeType;
  key: string;
  title: string;
  summary: string;
  status: NodeStatus;
  attrs: NodeAttrs;
  /** yyyy-mm-dd, the arena's local day. */
  firstSeenDay: string;
  lastSeenDay: string;
}

export interface NodeAttrs {
  needs_confirmation?: boolean;
  /** Why a decision was made, in a line. */
  why?: string;
  /** A person's roles in the arena, as people called them. */
  roles?: string[];
  /** Decision / rule: who set it, by name (also an edge, kept here for the table). */
  by?: string;
  /** Milestone / action item: the date it is due, yyyy-mm-dd, when someone said one. */
  due?: string;
  /** Decision: 'architecture' for a technical or architectural one (the playbook's Architecture). */
  kind?: string;
  /** Artifact: the arena file it is, from the file version the extraction cited (F1…). */
  artifact_id?: string;
  /** The product summary node (PRODUCT_KEY): what is in scope, in a line or two. */
  scope?: string;
  [extra: string]: unknown;
}

export interface MemoryEdge {
  id: string;
  src: string;
  dst: string;
  type: EdgeType;
  confidence: number;
}

// ---------------------------------------------------------------- the AI's reply (strict)

/** A source the AI may cite: M3 (message), E2 (event), F1 (file version), P1 (pull request). */
export const REF = /^[MEFP]\d{1,4}$/;
/** A file version of the day (F1…), for an Artifact node. */
export const FILE_REF = /^F\d{1,4}$/;
/** A calendar date, yyyy-mm-dd. */
export const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** Decision kinds the playbook sorts on. */
export const DECISION_KINDS = ['architecture'] as const;

/**
 * The product's vision and scope live on one Topic node with this key (no new node type: the 0017
 * CHECK stays). A slug never starts with "_", so no glossary term can take it.
 */
export const PRODUCT_KEY = '_product';
export const PRODUCT_TITLE = 'Product vision and scope';

/** The product summary node, if the memory has one. */
export const isProductNode = (n: Pick<MemoryNode, 'type' | 'key'>): boolean =>
  n.type === 'Topic' && n.key === PRODUCT_KEY;

const text = (max: number) => z.string().trim().min(1).max(max);
const refs = z.array(z.string().trim().regex(REF)).max(30).default([]);
const confidence = z.number().min(0).max(1).default(0.8);

export const ExtractedNodeSchema = z
  .object({
    /** The AI's own handle for this node within the reply ("n1"), for edges. */
    ref: z.string().trim().min(1).max(20),
    type: z.enum(NODE_TYPES),
    /** An existing key it means ("D-003", "asha"), else null for a new item. */
    key: z.string().trim().min(1).max(120).nullable().default(null),
    title: text(300),
    summary: z.string().trim().max(2000).default(''),
    status: z.enum(NODE_STATUSES).nullable().default(null),
    why: z.string().trim().max(500).nullable().default(null),
    roles: z.array(text(60)).max(8).default([]),
    /** Milestone / ActionItem: the due date when one was said. */
    due: z.string().trim().regex(DAY).nullable().default(null),
    /** Decision: 'architecture' when it is technical or architectural. */
    kind: z.enum(DECISION_KINDS).nullable().default(null),
    /** Artifact: the file version it is (F1…). */
    file: z.string().trim().regex(FILE_REF).nullable().default(null),
    refs,
    confidence,
  })
  .strict();

export const ExtractedEdgeSchema = z
  .object({
    /** A node ref of this reply ("n1") or an existing key ("D-003", "asha"). */
    from: z.string().trim().min(1).max(120),
    to: z.string().trim().min(1).max(120),
    type: z.enum(EDGE_TYPES),
    refs,
    confidence,
  })
  .strict();

export const ExtractionSchema = z
  .object({
    nodes: z.array(ExtractedNodeSchema).max(80).default([]),
    edges: z.array(ExtractedEdgeSchema).max(160).default([]),
    /** The new item replaces an old one of the same type (a reversed decision, a changed rule). */
    supersedes: z
      .array(
        z
          .object({
            new: z.string().trim().min(1).max(120),
            old: z.string().trim().min(1).max(120),
            refs,
          })
          .strict(),
      )
      .max(40)
      .default([]),
    /**
     * What the product is and what is in scope, when the day states or changes it (else null). It
     * replaces the memory's product summary.
     */
    product: z
      .object({
        vision: text(600),
        scope: z.string().trim().max(600).default(''),
        refs,
      })
      .strict()
      .nullable()
      .default(null),
    /** An existing item moved on: a question answered, an action done, a risk gone. */
    status_changes: z
      .array(
        z
          .object({
            key: z.string().trim().min(1).max(120),
            status: z.enum(NODE_STATUSES),
            refs,
          })
          .strict(),
      )
      .max(80)
      .default([]),
  })
  .strict();
export type Extraction = z.output<typeof ExtractionSchema>;
export type ExtractedNode = z.output<typeof ExtractedNodeSchema>;

/** The JSON object in a reply: the whole reply, or its first ```json fence, or its outer braces. */
export function jsonOf(reply: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply)?.[1];
  const body = (fence ?? reply).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  return start === -1 || end <= start ? null : body.slice(start, end + 1);
}

export type ParsedExtraction = { ok: true; value: Extraction } | { ok: false; error: string };

/** The AI's extraction, validated; the error (field paths, never content) for one repair try. */
export function parseExtraction(reply: string | null | undefined): ParsedExtraction {
  const raw = reply ? jsonOf(reply) : null;
  if (!raw) return { ok: false, error: 'the reply has no JSON object' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'the JSON does not parse' };
  }
  const parsed = ExtractionSchema.safeParse(data);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 6)
    // The path and the kind of problem only: zod messages can echo the values.
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.code.replace(/_/g, ' ')}`)
    .join('; ');
  return { ok: false, error: issues };
}

/** "Checkout Service!" → "checkout-service". */
export function slug(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'item'
  );
}

const STOP = new Set(
  'a an and are as at be by for from has have in into is it its of on or that the this to was we will with'.split(
    ' ',
  ),
);

/** The title's meaningful words, for matching ("Use Postgres for events" ≈ "use postgres events"). */
export function words(value: string): Set<string> {
  return new Set(
    value
      .normalize('NFKD')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
}

/** Jaccard similarity of two titles' words (0..1). */
export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both += 1;
  return both / (x.size + y.size - both);
}
