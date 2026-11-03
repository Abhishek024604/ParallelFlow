import { mcpServerConfig, SEMGREP, SENTRY } from '@parallelflow/pi-parallelflow';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTool } from './agent.js';
import { connectorNames, remoteLaunch, resolveConnectors } from './connectors.js';
import { arenaTools } from './pi-engine.js';
import { buildErrorLines, vercelTools } from './vercel.js';

// Server-wide remote connectors (Sentry, Semgrep) and the Vercel deploy tools. No network: fetch is
// a mock and the connectors are only resolved, never connected.

describe('remote connectors', () => {
  it('sends the Sentry key as a Sentry-Bearer header that never enters the server config', () => {
    const launch = remoteLaunch(SENTRY, { SENTRY_AUTH_TOKEN: ' sntryu_secret ' });
    expect(launch?.remote).toEqual({
      url: 'https://mcp.sentry.dev/mcp',
      headers: { Authorization: 'Sentry-Bearer sntryu_secret' },
    });
    const config = mcpServerConfig(launch!);
    expect(config).toMatchObject({ type: 'http', url: 'https://mcp.sentry.dev/mcp' });
    expect(JSON.stringify(config)).not.toContain('sntryu_secret');
    expect(config.toolExposure).not.toHaveProperty('update_issue');
  });

  it('skips Sentry without a key, and connects Semgrep without one', () => {
    const skipped: string[] = [];
    const names = connectorNames('sentry,semgrep');
    const launches = resolveConnectors(names, '/unused', {}, (name) => skipped.push(name));
    expect(skipped).toEqual(['sentry']);
    expect(launches.map((l) => l.connector)).toEqual([SEMGREP]);
    expect(launches[0]?.remote).toEqual({ url: 'https://mcp.semgrep.ai/mcp', headers: {} });
  });
});

describe('vercel tools', () => {
  const ok = (body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200 });

  it('are absent without a key, and only for arena sessions that are not forks', () => {
    expect(vercelTools(undefined)).toEqual([]);
    expect(vercelTools({ token: '' })).toEqual([]);
    const tools = vercelTools({ token: 'vt' });
    expect(tools.map((t) => t.name)).toEqual([
      'vercel_list_deployments',
      'vercel_get_deployment',
      'vercel_build_errors',
    ]);
    expect(arenaTools(tools, 'central_arena', false)).toHaveLength(3);
    expect(arenaTools(tools, 'personal_private', false)).toEqual([]);
    expect(arenaTools(tools, 'central_arena', true)).toEqual([]);
  });

  it('calls the REST API with the Bearer key and team, and returns no key', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        deployments: [
          {
            uid: 'dpl_1',
            name: 'web',
            url: 'web-abc.vercel.app',
            readyState: 'ERROR',
            createdAt: 0,
            meta: { githubCommitRef: 'main' },
          },
        ],
      }),
    );
    const [list] = vercelTools({ token: 'vercel_secret', teamId: 'team_1' }, fetchMock);
    const text = await (list as AgentTool).execute({ project: 'web', limit: 5 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.pathname).toBe('/v6/deployments');
    expect(url.searchParams.get('app')).toBe('web');
    expect(url.searchParams.get('teamId')).toBe('team_1');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer vercel_secret');
    expect(JSON.parse(text)).toEqual({
      deployments: [
        {
          id: 'dpl_1',
          project: 'web',
          url: 'web-abc.vercel.app',
          state: 'ERROR',
          target: 'preview',
          created: '1970-01-01T00:00:00.000Z',
          branch: 'main',
        },
      ],
    });
    expect(text).not.toContain('vercel_secret');
  });

  it('refuses an unsafe deployment ref and maps a refused key to FORBIDDEN', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 403 }));
    const [, get] = vercelTools({ token: 'vt' }, fetchMock);
    await expect(get!.execute({ deployment: '../../v2/user' })).rejects.toMatchObject({
      code: 'INVALID_ARGS',
    });
    await expect(get!.execute({ deployment: 'https://web-abc.vercel.app/' })).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toContain(
      '/v13/deployments/web-abc.vercel.app',
    );
  });

  it('keeps only the error and warning lines of a build log', () => {
    const log = [
      { type: 'stdout', payload: { text: 'Installing dependencies' } },
      { type: 'stderr', payload: { text: 'npm WARN deprecated x' } },
      { type: 'stdout', payload: { text: 'Error: Cannot find module y' } },
    ];
    expect(buildErrorLines(JSON.stringify(log))).toEqual([
      'npm WARN deprecated x',
      'Error: Cannot find module y',
    ]);
    expect(buildErrorLines(log.map((l) => JSON.stringify(l)).join('\n'))).toHaveLength(2);
  });
});
