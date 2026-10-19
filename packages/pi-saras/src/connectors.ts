import type { SarasProfile } from './context.js';

// Connectors: external MCP servers that Pi runs for a Saras session (Pi's MCP client,
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

export interface SarasConnector {
  /** MCP server name. Pi names its tools `mcp__<name>__<tool>`. */
  name: string;
  /** What it offers, in a sentence (Pi's server listing and tool search use it). */
  description: string;
  /** The npm package and the file the host runs with node. */
  package: string;
  entry: string;
  /** The tools the model may call, with their autonomy class. Every other tool is hidden. */
  tools: Readonly<Record<string, string>>;
  /** The profiles whose sessions get it. */
  profiles: readonly SarasProfile[];
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
 * CDN. Diagrams are saved as Saras documents, not opened anywhere.
 */
export const DRAWIO: SarasConnector = {
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

/** Every connector Saras knows, by name. Hosts enable a subset (RUNTIME_CONNECTORS). */
export const CONNECTORS: Readonly<Record<string, SarasConnector>> = { drawio: DRAWIO };

export const mcpToolName = (server: string, tool: string): string => `mcp__${server}__${tool}`;

/** `mcp__drawio__search_shapes` → drawio / search_shapes; null for any other name. */
export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([A-Za-z0-9-]+)__(.+)$/.exec(name);
  return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : null;
}

/** The model-facing tool names of these connectors (the host's tool allowlist). */
export function connectorToolNames(connectors: readonly SarasConnector[]): string[] {
  return connectors.flatMap((c) => Object.keys(c.tools).map((t) => mcpToolName(c.name, t)));
}

/** The connectors a profile gets, from the enabled ones. */
export function connectorsFor(
  profile: SarasProfile,
  enabled: readonly SarasConnector[],
): SarasConnector[] {
  return enabled.filter((c) => c.profiles.includes(profile));
}

/** A started connector: what the host resolved for it. */
export interface ConnectorLaunch {
  connector: SarasConnector;
  /** Absolute path of node and the args (the package entry). */
  command: string;
  args: readonly string[];
  /** The connector's env plus host additions (its cache folder). */
  env: Readonly<Record<string, string>>;
  /** Working folder (the host's sandbox lets the server read only its own folders). */
  cwd?: string;
}

/** The `pi.registerMcpServer` config for a launch (stdio; only the listed tools exposed). */
export function mcpServerConfig(launch: ConnectorLaunch) {
  const c = launch.connector;
  return {
    type: 'stdio' as const,
    command: launch.command,
    args: [...launch.args],
    env: { ...launch.env },
    description: c.description,
    exposure: 'hidden' as const,
    toolExposure: Object.fromEntries(Object.keys(c.tools).map((t) => [t, 'direct' as const])),
    ...(c.timeoutS && { timeout: c.timeoutS }),
  };
}

export type ConnectorCallCheck =
  | { kind: 'not_connector' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'allowed'; connector: SarasConnector; tool: string; autonomyClass: string };

/** What `tool_call` does with a tool name: not ours, blocked (unknown tool), or allowed + class. */
export function checkConnectorCall(
  toolName: string,
  connectors: readonly SarasConnector[],
): ConnectorCallCheck {
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return { kind: 'not_connector' };
  const connector = connectors.find((c) => c.name === parsed.server);
  const cls = connector?.tools[parsed.tool];
  if (!connector || !cls) {
    return { kind: 'blocked', reason: 'BLOCKED: that tool is not available in Saras.' };
  }
  return { kind: 'allowed', connector, tool: parsed.tool, autonomyClass: cls };
}

/** Removes a tool's dropped arguments from its input, in place. Returns the names removed. */
export function dropConnectorArgs(
  connector: SarasConnector,
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
