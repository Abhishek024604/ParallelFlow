import { describe, expect, it } from 'vitest';
import { buildDiagram } from './diagram-layout.js';
import { DiagramSpecError, parseSpec, specToXml } from './diagram-spec.js';

const SPEC = {
  title: 'Orders',
  groups: [{ id: 'backend', label: 'Backend' }],
  nodes: [
    { id: 'web', label: 'Web app' },
    { id: 'api', label: 'Orders API', group: 'backend' },
    { id: 'db', label: 'Orders DB', type: 'database', group: 'backend' },
  ],
  edges: [
    { from: 'web', to: 'api', label: 'HTTPS' },
    { from: 'api', to: 'db', label: 'SQL' },
  ],
};

describe('diagram spec', () => {
  it('builds a laid-out draw.io diagram with groups, shapes, labels and a title', async () => {
    const out = await buildDiagram(JSON.stringify(SPEC), undefined);
    expect(out).toMatchObject({ laidOut: true, layout: 'flow' });
    expect(out.xml).toContain('value="Backend"');
    expect(out.xml).toContain('shape=cylinder3');
    expect(out.xml).toContain('value="HTTPS"');
    expect(out.xml).toContain('value="Orders"');
    // The edge inside the group lives in the group.
    expect(specToXml(parseSpec(JSON.stringify(SPEC)))).toMatch(/source="api" target="db"/);
    expect(specToXml(parseSpec(JSON.stringify(SPEC)))).toMatch(/parent="backend" source="api"/);
  }, 30_000);

  it('tells the AI what to fix in a bad spec', () => {
    const bad = (s: unknown) => () => parseSpec(JSON.stringify(s));
    expect(bad({ nodes: [] })).toThrow(DiagramSpecError);
    expect(bad({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] })).toThrow(/"b"/);
    expect(bad({ nodes: [{ id: 'a', type: 'cloud' }] })).toThrow(/use one of/);
    expect(bad({ nodes: [{ id: 'a' }, { id: 'a' }] })).toThrow(/twice/);
    expect(() => parseSpec('{nope')).toThrow(/not valid JSON/);
  });

  it('escapes labels', () => {
    const xml = specToXml(parseSpec(JSON.stringify({ nodes: [{ id: 'a', label: '<b>"x" & y' }] })));
    expect(xml).toContain('value="&lt;b&gt;&quot;x&quot; &amp; y"');
  });
});
