import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { DRAWIO } from '@parallelflow/pi-parallelflow';
import { afterAll, describe, expect, it } from 'vitest';
import type { CreateAgentOptions, HarnessEvent } from './agent.js';
import {
  connectorEnv,
  connectorNames,
  packagesDir,
  resolveConnectors,
  sandboxArgs,
} from './connectors.js';
import { PiEngine, sessionConnectors } from './pi-engine.js';

// Connectors: the launch rules, then the real Pi harness (faux model, no network for the model)
// running the real, sandboxed @drawio/mcp server through Pi's MCP client.

const root = mkdtempSync(join(tmpdir(), 'parallelflow-connectors-'));
// A disposed session's connector process exits a moment later (its session_shutdown closes it);
// on Windows its folder cannot be removed until then. Ten seconds is far more than it needs.
afterAll(async () => {
  for (let i = 0; ; i++) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 40) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
});

describe('connector launch', () => {
  it('reads RUNTIME_CONNECTORS against the catalog (default drawio, empty = none)', () => {
    expect(connectorNames(undefined)).toEqual(['drawio']);
    expect(connectorNames('')).toEqual([]);
    expect(connectorNames(' DrawIO, drawio ')).toEqual(['drawio']);
    expect(() => connectorNames('drawio,shell')).toThrow(/unknown connector "shell"/);
  });

  it('sandboxes the server: permission model, own folder, preload, no inherited secrets', () => {
    const [launch] = resolveConnectors(['drawio'], join(root, 'data'));
    expect(launch?.command).toBe(process.execPath);
    expect(launch?.args).toContain('--permission');
    expect(launch?.args.some((a) => a.startsWith('--allow-fs-write='))).toBe(true);
    expect(launch?.args.some((a) => a.startsWith('--allow-child-process'))).toBe(false);
    expect(launch?.args.at(-1)).toMatch(/@drawio[\\/]mcp[\\/]src[\\/]index\.js$/);
    expect(Object.keys(launch?.env ?? {})).not.toContain('PATH');
    expect(JSON.stringify(launch?.env)).not.toMatch(/OPENROUTER|RUNTIME_JWT|KEY/);
    expect(connectorEnv('/h', 'linux')).toEqual({
      HOME: '/h',
      XDG_CACHE_HOME: join('/h', 'cache'),
      TMPDIR: join('/h', 'tmp'),
      NODE_ENV: 'production',
    });
    expect(sandboxArgs({ packages: '/p', home: '/h', preload: '/s.mjs' })).toEqual([
      '--permission',
      '--allow-fs-read=/p',
      '--allow-fs-read=/s.mjs',
      '--allow-fs-read=/h',
      '--allow-fs-write=/h',
      '--import',
      pathToFileURL('/s.mjs').href,
    ]);
  });

  it('finds the folder that holds the package and its dependencies', () => {
    const sep = join('a', 'b').slice(1, 2);
    const p = (...parts: string[]) => parts.join(sep);
    expect(
      packagesDir(
        p('', 'r', 'node_modules', '.pnpm', '@drawio+mcp@1', 'node_modules', '@drawio', 'mcp'),
      ),
    ).toBe(p('', 'r', 'node_modules', '.pnpm'));
    expect(packagesDir(p('', 'app', 'node_modules', '@drawio', 'mcp'))).toBe(
      p('', 'app', 'node_modules'),
    );
  });

  it('gives connectors to the profiles that have them, never to a fork', () => {
    const launch = { connector: DRAWIO, command: 'node', args: [], env: {} };
    expect(sessionConnectors([launch], 'central_arena', false)).toHaveLength(1);
    expect(sessionConnectors([launch], 'personal_private', undefined)).toHaveLength(1);
    expect(sessionConnectors([launch], 'coder', false)).toHaveLength(0);
    expect(sessionConnectors([launch], 'central_arena', true)).toHaveLength(0);
  });
});

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
const piNode = major > 22 || (major === 22 && minor >= 19);

describe.skipIf(!piNode)('draw.io through Pi (faux model, real sandboxed server)', () => {
  const faux = fauxProvider({
    provider: 'faux',
    models: [
      { id: 'fast', contextWindow: 100_000, maxTokens: 4_000 },
      { id: 'strong', contextWindow: 100_000, maxTokens: 4_000 },
    ],
  });
  const dataDir = join(root, 'engine');

  it('runs allowed tools in the sandbox, hides the rest, drops layout args, cleans results', async () => {
    const engine = new PiEngine({
      apiKey: 'faux-key',
      routing: { fast: ['fast'], strong: ['strong'], fallbacks: [] },
      dataDir,
      provider: 'faux',
      prepareRuntime: (runtime) => runtime.registerNativeProvider(faux.provider),
      connectors: resolveConnectors(['drawio'], dataDir),
    });
    await engine.init();
    const dir = join(root, 'arena');
    const options: CreateAgentOptions = {
      sessionDir: join(dir, 'pi'),
      cwd: join(dir, 'workspace'),
      agentDir: join(dir, 'agent'),
      session: { profile: 'central_arena', agentName: 'AI' },
      turnContext: () => undefined,
      onQuestion: () => undefined,
      tools: [],
    };
    const handle = await engine.create(options);
    const xml =
      '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
      '<mxCell id="2" value="Web" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="60" as="geometry"/></mxCell>' +
      '</root></mxGraphModel>';
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall('mcp__drawio__get_drawio_reference', { format: 'xml' })),
      fauxAssistantMessage(
        fauxToolCall('mcp__drawio__open_drawio_xml', { content: xml, postLayout: 'elk' }),
      ),
      fauxAssistantMessage(fauxToolCall('mcp__drawio__get_page', { path: 'x.drawio', page: 0 })),
      fauxAssistantMessage('Created web.drawio (draft) — the web tier.'),
    ]);
    const events: HarnessEvent[] = [];
    handle.subscribe((e) => events.push(e));
    await handle.prompt('/diagram the web tier');

    const ends = events.filter((e) => e.type === 'tool_execution_end') as unknown as {
      toolName: string;
      isError: boolean;
      result?: { content?: { type: string; text?: string }[] };
    }[];
    const reference = ends.find((e) => e.toolName === 'mcp__drawio__get_drawio_reference');
    expect(reference?.isError).toBe(false);
    expect(reference?.result?.content?.[0]?.text).toContain('mxCell');
    const opened = ends.find((e) => e.toolName === 'mcp__drawio__open_drawio_xml');
    expect(opened?.isError).toBe(false);
    const text = opened?.result?.content?.[0]?.text ?? '';
    expect(text).toContain('https://app.diagrams.net/');
    expect(text).toContain('do not paste this link');
    expect(text).not.toContain('opened in your default browser');
    expect(text).not.toContain('ELK');
    // A hidden file tool is not there at all.
    const page = ends.find((e) => e.toolName === 'mcp__drawio__get_page');
    expect(page?.isError).toBe(true);
    expect(page?.result?.content?.[0]?.text).toMatch(/not found/);
    handle.dispose();
  }, 60_000);
});
