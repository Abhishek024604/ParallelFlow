import { describe, expect, it } from 'vitest';
import { autonomyDecision } from './autonomy.js';
import {
  checkConnectorCall,
  CONNECTORS,
  connectorsFor,
  connectorToolNames,
  DRAWIO,
  dropConnectorArgs,
  mcpServerConfig,
  parseMcpToolName,
} from './connectors.js';
import { sanitizeAiText } from './guardrails.js';

describe('connector catalog and rules', () => {
  it('exposes only the listed draw.io tools to the model', () => {
    const config = mcpServerConfig({
      connector: DRAWIO,
      command: '/usr/bin/node',
      args: ['/srv/node_modules/@drawio/mcp/src/index.js'],
      env: { HOME: '/data/connectors/drawio' },
    });
    expect(config).toMatchObject({
      type: 'stdio',
      command: '/usr/bin/node',
      exposure: 'hidden',
      toolExposure: {
        get_drawio_reference: 'direct',
        search_shapes: 'direct',
        open_drawio_xml: 'direct',
        open_drawio_mermaid: 'direct',
      },
    });
    for (const fileTool of ['list_pages', 'get_page', 'set_page', 'open_drawio_csv']) {
      expect(config.toolExposure).not.toHaveProperty(fileTool);
    }
    expect(connectorToolNames([DRAWIO])).toContain('mcp__drawio__open_drawio_xml');
    expect(Object.keys(CONNECTORS)).toEqual(['drawio']);
  });

  it('blocks any other tool of a connector, and passes non-connector tools through', () => {
    expect(parseMcpToolName('mcp__drawio__get_page')).toEqual({
      server: 'drawio',
      tool: 'get_page',
    });
    expect(parseMcpToolName('artifacts_read')).toBeNull();
    expect(checkConnectorCall('mcp__drawio__set_page', [DRAWIO]).kind).toBe('blocked');
    expect(checkConnectorCall('mcp__other__x', [DRAWIO]).kind).toBe('blocked');
    expect(checkConnectorCall('artifacts_read', [DRAWIO]).kind).toBe('not_connector');
    expect(checkConnectorCall('mcp__drawio__search_shapes', [DRAWIO])).toMatchObject({
      kind: 'allowed',
      tool: 'search_shapes',
      autonomyClass: 'answer',
    });
  });

  it('applies the arena autonomy to connector tools by their class', () => {
    expect(autonomyDecision('drawio.search_shapes', { answer: 'off' }, 'answer').block).toBe(true);
    expect(autonomyDecision('drawio.search_shapes', { answer: 'act' }, 'answer').block).toBe(false);
  });

  it('drops the layout passes that download and run code', () => {
    const input: Record<string, unknown> = {
      content: '<mxGraphModel/>',
      postLayout: 'elk',
      routing: 'libavoid',
      direction: 'RIGHT',
      dark: 'auto',
    };
    expect(dropConnectorArgs(DRAWIO, 'open_drawio_xml', input).sort()).toEqual([
      'direction',
      'postLayout',
      'routing',
    ]);
    expect(input).toEqual({ content: '<mxGraphModel/>', dark: 'auto' });
    expect(dropConnectorArgs(DRAWIO, 'search_shapes', { query: 'aws' })).toEqual([]);
  });

  it('rewrites the open result: no browser claim, a "do not paste" instruction', () => {
    const raw =
      'Draw.io Editor URL:\nhttps://app.diagrams.net/?grid=0#Rabc\n\nThe diagram has been opened in your default browser.';
    const clean = DRAWIO.cleanResult?.('open_drawio_xml', raw) ?? '';
    expect(clean).not.toContain('opened in your default browser');
    expect(clean).toContain('do not paste this link');
    expect(clean).toContain('https://app.diagrams.net/?grid=0#Rabc');
  });

  it('is given to arena and private sessions only', () => {
    expect(connectorsFor('central_arena', [DRAWIO])).toEqual([DRAWIO]);
    expect(connectorsFor('personal_private', [DRAWIO])).toEqual([DRAWIO]);
    expect(connectorsFor('coder', [DRAWIO])).toEqual([]);
  });

  it('leaves a draw.io link intact in the AI reply filter', () => {
    const link =
      'https://app.diagrams.net/?grid=0&pv=0&border=10&edit=_blank#R7VhRb5swEP41eWzEgUDymLRpN6mTKnXa2j1V3nBga8bIGAL79TNgcPKkVbKmVaRN6oOP0DvvO%2FvOPhFg01Ph8QvT%2B9Z4HJvB%2F4Ma2ZLsQIi%2BhTxV5AD5wQZpAiQ';
    expect(sanitizeAiText(`Open it here: ${link}`)).toBe(`Open it here: ${link}`);
  });
});
