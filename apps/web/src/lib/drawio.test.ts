import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { drawioHash, drawioViewerUrl, isDrawioName, looksLikeDrawio } from './drawio';

const XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="2" value="Web → API &amp; DB" vertex="1" parent="1"/></root></mxGraphModel>';

/** How draw.io reads `#R…`: URI-decode, base64, inflate raw, URI-decode. */
const decode = (hash: string) =>
  decodeURIComponent(
    inflateRawSync(Buffer.from(decodeURIComponent(hash.slice(2)), 'base64')).toString('utf8'),
  );

describe('draw.io links', () => {
  it('encodes the XML in draw.io #R format, round trip intact', async () => {
    const hash = await drawioHash(XML);
    expect(hash.startsWith('#R')).toBe(true);
    expect(decode(hash)).toBe(XML);
  });

  it('keeps the diagram in the fragment of the viewer link', async () => {
    const viewer = await drawioViewerUrl(XML);
    expect(viewer.startsWith('https://viewer.diagrams.net/?lightbox=1')).toBe(true);
    const [beforeHash, hash] = viewer.split('#');
    expect(beforeHash).not.toContain('mxGraphModel');
    expect(beforeHash).not.toContain('edit=');
    expect(decode(`#${hash}`)).toBe(XML);
  });

  it('recognises diagrams by name and content', () => {
    expect(isDrawioName('checkout-architecture.drawio')).toBe(true);
    expect(isDrawioName('plan.md')).toBe(false);
    expect(looksLikeDrawio(`  ${XML}`)).toBe(true);
    expect(looksLikeDrawio('<mxfile host="app"><diagram/></mxfile>')).toBe(true);
    expect(looksLikeDrawio('# not a diagram')).toBe(false);
  });
});
