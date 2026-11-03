import type { ParallelFlowProfile } from './context.js';

// Connectors: external MCP servers that Pi runs for a ParallelFlow session (Pi's MCP client,
// `pi.registerMcpServer`). This file is the catalog and its rules, as plain data and pure functions;
// the extension applies them in Pi's hooks and the host (apps/runtime) starts the servers.
//
// Every connector is locked down the same way:
//   - pinned: the host starts the package from its own lockfile with node (never `npx -y`);
//   - only the listed tools are exposed to the model (`exposure: hidden` + per-tool `direct`), and
//     the extension blocks any other tool of the server again in `tool_call`;
//   - each listed tool has an autonomy class, enforced like an App Tool's;
//   - `dropArgs` are removed from calls before the server sees them, `cleanResult` rewrites results;
//   - the host gives the server no environment of its own (no keys, no PATH): only `env` below.

export interface ParallelFlowConnector {
  /** MCP server name. Pi names its tools `mcp__<name>__<tool>`. */
  name: string;
  /** What it offers, in a sentence (Pi's server listing and tool search use it). */
  description: string;
  /** The npm package and the file the host runs with node (local connectors). */
  package?: string;
  entry?: string;
  /** A remote MCP server (Streamable HTTP), for a person's own connected service (ADR-039). */
  url?: string;
  /**
   * A server-wide remote connector's key: the host reads it from its own environment variable `env`
   * and sends `Authorization: <scheme> <key>`. Without it a `required` connector is skipped.
   */
  credential?: { env: string; scheme: string; required: boolean };
  /** The tools the model may call, with their autonomy class. Every other tool is hidden. */
  tools: Readonly<Record<string, string>>;
  /** The profiles whose sessions get it. */
  profiles: readonly ParallelFlowProfile[];
  /** Fixed environment for the server (never secrets). The host adds only its cache folder. */
  env?: Readonly<Record<string, string>>;
  /** Arguments removed from a tool's calls before they reach the server. */
  dropArgs?: Readonly<Record<string, readonly string[]>>;
  /** Rewrites a successful text result of one of its tools. */
  cleanResult?: (tool: string, text: string) => string;
  /** Per-request timeout in seconds. */
  timeoutS?: number;
}

const DRAWIO_OPENED = /\n*\s*The diagram has been opened in your default browser\.\s*/g;

/**
 * draw.io (`@drawio/mcp`, the official server). The open_drawio_* tools build an app.diagrams.net
 * link (the diagram rides in its #fragment) and try to open a browser on the host, which the host
 * prevents (no PATH); the page/file tools that read and write host paths stay hidden; the layout
 * passes (`postLayout`, `routing`) are dropped because they download and run code from the draw.io
 * CDN. Diagrams are saved as ParallelFlow documents, not opened anywhere.
 */
export const DRAWIO: ParallelFlowConnector = {
  name: 'drawio',
  description:
    'draw.io diagrams: the XML and Mermaid authoring reference, shape and icon search, and a check that builds the diagram and its draw.io link',
  package: '@drawio/mcp',
  entry: 'src/index.js',
  tools: {
    get_drawio_reference: 'answer',
    search_shapes: 'answer',
    open_drawio_xml: 'answer',
    open_drawio_mermaid: 'answer',
  },
  profiles: ['central_arena', 'personal_private'],
  env: { DRAWIO_BASE_URL: 'https://app.diagrams.net/' },
  dropArgs: {
    open_drawio_xml: ['postLayout', 'routing', 'direction'],
    open_drawio_mermaid: ['postLayout'],
  },
  cleanResult: (_tool, text) =>
    text
      .replace(DRAWIO_OPENED, '\n\n')
      .replace(
        /^Draw\.io Editor URL:/m,
        'The diagram is valid. Save it as a document; do not paste this link into your reply. Draw.io link:',
      )
      .trim(),
  timeoutS: 60,
};

const LINEAR_READ = [
  'list_issues',
  'list_my_issues',
  'get_issue',
  'list_comments',
  'list_teams',
  'get_team',
  'list_projects',
  'get_project',
  'list_cycles',
  'list_issue_statuses',
  'get_issue_status',
  'list_issue_labels',
  'list_project_labels',
  'list_users',
  'get_user',
  'list_documents',
  'get_document',
  'search_documentation',
] as const;
const LINEAR_WRITE = [
  'create_issue',
  'update_issue',
  'create_comment',
  'create_project',
  'update_project',
  'create_issue_label',
] as const;

/**
 * Linear's official remote MCP server, for the Product Manager extension (ADR-039). It is never
 * server-wide: a private session gets it only when its owner installed PM and connected Linear, and
 * it acts with that person's own key (the host sends it as a Bearer header; it is never in the
 * server config, a prompt or a log). Reads are `answer`; writes are `tracker_write`, which the PM
 * skill only uses after the owner confirms a preview. Deletes and other tools stay hidden.
 */
export const LINEAR: ParallelFlowConnector = {
  name: 'linear',
  description:
    "The person's Linear workspace: teams, projects, cycles, issues and comments; create and update issues after the person confirms",
  url: 'https://mcp.linear.app/mcp',
  tools: Object.fromEntries([
    ...LINEAR_READ.map((t) => [t, 'answer']),
    ...LINEAR_WRITE.map((t) => [t, 'tracker_write']),
  ]),
  profiles: ['personal_private'],
  timeoutS: 60,
};

/** Sentry's read-only tools (each has readOnlyHint in getsentry/sentry-mcp). Writes stay hidden. */
const SENTRY_READ = [
  'whoami',
  'find_organizations',
  'find_projects',
  'find_teams',
  'find_releases',
  'get_release_details',
  'get_issue_details',
  'get_issue_activity',
  'get_issue_breadcrumbs',
  'get_issue_tag_values',
  'get_event_stacktrace',
  'get_trace_details',
  'get_span_details',
  'search_issues',
  'search_issue_events',
  'search_events',
  'search_errors',
  'search_logs',
  'search_traces',
  'search_docs',
  'get_doc',
  'get_sentry_resource',
] as const;

/**
 * Sentry's official remote MCP server, for the arena's AI: production errors, traces and releases
 * flow back into the loop. One server-wide account (SENTRY_AUTH_TOKEN, sent as `Sentry-Bearer`, the
 * scheme for a user token); reads only, so issue updates, alert and project changes stay hidden.
 */
export const SENTRY: ParallelFlowConnector = {
  name: 'sentry',
  description:
    'Sentry: production errors, issues, stack traces, traces, logs and releases of the connected Sentry organization (read only)',
  url: 'https://mcp.sentry.dev/mcp',
  credential: { env: 'SENTRY_AUTH_TOKEN', scheme: 'Sentry-Bearer', required: true },
  tools: Object.fromEntries(SENTRY_READ.map((t) => [t, 'answer'])),
  profiles: ['central_arena'],
  timeoutS: 90,
};

/**
 * Semgrep's hosted MCP server (experimental, no key): static analysis of code the AI passes in, for
 * security review before a gate. The code it scans is sent to Semgrep. semgrep_findings (needs an
 * AppSec Platform token) and the rule-writing prompt stay hidden.
 */
export const SEMGREP: ParallelFlowConnector = {
  name: 'semgrep',
  description:
    'Semgrep: scan code for security issues and bugs with Semgrep rules or a custom rule, and show its syntax tree',
  url: 'https://mcp.semgrep.ai/mcp',
  tools: {
    security_check: 'answer',
    semgrep_scan: 'answer',
    semgrep_scan_with_custom_rule: 'answer',
    get_abstract_syntax_tree: 'answer',
    supported_languages: 'answer',
    semgrep_rule_schema: 'answer',
  },
  profiles: ['central_arena'],
  timeoutS: 120,
};

/** Every connector ParallelFlow knows, by name. Hosts enable a subset (RUNTIME_CONNECTORS). */
export const CONNECTORS: Readonly<Record<string, ParallelFlowConnector>> = {
  drawio: DRAWIO,
  sentry: SENTRY,
  semgrep: SEMGREP,
};

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/** `mcp__drawio__search_shapes` → drawio / search_shapes; null for any other name. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([A-Za-z0-9-]+)__(.+)$/.exec(name);
  return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : null;
}

/** The model-facing tool names of these connectors (the host's tool allowlist). */
export function connectorToolNames(connectors: readonly ParallelFlowConnector[]): string[] {
  return connectors.flatMap((c) => Object.keys(c.tools).map((t) => mcpToolName(c.name, t)));
}

/** The connectors a profile gets, from the enabled ones. */
export function connectorsFor(
  profile: ParallelFlowProfile,
  enabled: readonly ParallelFlowConnector[],
): ParallelFlowConnector[] {
  return enabled.filter((c) => c.profiles.includes(profile));
}

/** A started connector: what the host resolved for it. */
export interface ConnectorLaunch {
  connector: ParallelFlowConnector;
  /** Absolute path of node and the args (the package entry). */
  command: string;
  args: readonly string[];
  /** The connector's env plus host additions (its cache folder). */
  env: Readonly<Record<string, string>>;
  /** Working folder (the host's sandbox lets the server read only its own folders). */
  cwd?: string;
  /**
   * A remote server instead of a process (command and args are then unused): where, and the
   * headers the host's transport sends (a credential: never logged, never in the server config).
   */
  remote?: { url: string; headers: Readonly<Record<string, string>> };
}

/** The `pi.registerMcpServer` config for a launch (stdio; only the listed tools exposed). */
export function mcpServerConfig(launch: ConnectorLaunch) {
  const c = launch.connector;
  const exposure = {
    description: c.description,
    exposure: 'hidden' as const,
    toolExposure: Object.fromEntries(Object.keys(c.tools).map((t) => [t, 'direct' as const])),
    ...(c.timeoutS && { timeout: c.timeoutS }),
  };
  // The headers stay with the host's transport: the registered config never holds a credential.
  if (launch.remote) return { type: 'http' as const, url: launch.remote.url, ...exposure };
  return {
    type: 'stdio' as const,
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
    ...exposure,
  };
}

export type ConnectorCallCheck =
  | { kind: 'not_connector' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'allowed'; connector: ParallelFlowConnector; tool: string; autonomyClass: string };

/** What `tool_call` does with a tool name: not ours, blocked (unknown tool), or allowed + class. */
export function checkConnectorCall(
  toolName: string,
  connectors: readonly ParallelFlowConnector[],
): ConnectorCallCheck {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return { kind: 'not_connector' };
  const connector = connectors.find((c) => c.name === parsed.server);
  const cls = connector?.tools[parsed.tool];
  if (!connector || !cls) {
    return { kind: 'blocked', reason: 'BLOCKED: that tool is not available in ParallelFlow.' };
  }
  return { kind: 'allowed', connector, tool: parsed.tool, autonomyClass: cls };
}

/** Removes a tool's dropped arguments from its input, in place. Returns the names removed. */
export function dropConnectorArgs(
  connector: ParallelFlowConnector,
  tool: string,
  input: Record<string, unknown>,
): string[] {
  const removed: string[] = [];
  for (const arg of connector.dropArgs?.[tool] ?? []) {
    if (arg in input) {
      Reflect.deleteProperty(input, arg); // in place: Pi passes this input on to the server
      removed.push(arg);
    }
  }
  return removed;
}
