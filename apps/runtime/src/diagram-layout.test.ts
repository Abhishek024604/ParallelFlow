import { describe, expect, it } from 'vitest';
import { layoutDiagram, layoutOf } from './diagram-layout.js';

const box = (id: string, value: string) =>
  `<mxCell id="${id}" value="${value}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="0" y="0" width="120" height="60" as="geometry"/></mxCell>`;
const edge = (id: string, source: string, target: string) =>
  `<mxCell id="${id}" edge="1" source="${source}" target="${target}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`;
// Three boxes stacked on top of each other, as a weak model writes them.
const XML = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>${box('a', 'Web')}${box('b', 'API')}${box('c', 'DB')}${edge('e1', 'a', 'b')}${edge('e2', 'b', 'c')}</root></mxGraphModel>`;

describe('diagram layout', () => {
  it('spreads overlapping boxes out offline with the pinned ELK bundle', async () => {
    const done = await layoutDiagram(XML, 'flow');
    expect(done.laidOut).toBe(true);
    const xs = [...done.xml.matchAll(/<mxGeometry x="(\d+)"/g)].map((m) => Number(m[1]));
    expect(new Set(xs).size).toBe(3);
  }, 30_000);

  it('saves as written for none, and for content that is not draw.io XML', async () => {
    expect(await layoutDiagram(XML, 'none')).toEqual({ xml: XML, laidOut: false });
    expect(await layoutDiagram('not xml', 'route')).toEqual({ xml: 'not xml', laidOut: false });
    expect(layoutOf(undefined)).toBe('route');
    expect(layoutOf('flow')).toBe('flow');
  });
});
