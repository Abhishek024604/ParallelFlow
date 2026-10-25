// draw.io links for a .drawio document (draw.io's own `#R` format: the XML, URI-encoded, raw-deflated,
// base64, URI-encoded again). The diagram rides in the #fragment, which the browser never sends to
// diagrams.net: the viewer and editor read it in the page. Compression uses the browser's own
// CompressionStream, so there is no library.

export const DRAWIO_VIEWER = 'https://viewer.diagrams.net/';

/** A document that holds draw.io XML (the AI saves diagrams as `<name>.drawio`). */
export const isDrawioName = (name: string): boolean => /\.drawio$/i.test(name.trim());

/** Rough check that the text is draw.io XML (an mxfile or an mxGraphModel). */
export const looksLikeDrawio = (text: string): boolean =>
  /<(mxfile|mxGraphModel)[\s>]/.test(text.trimStart().slice(0, 2000));

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** `#R…` for the XML. */
export async function drawioHash(xml: string): Promise<string> {
  const packed = await deflateRaw(new TextEncoder().encode(encodeURIComponent(xml)));
  return `#R${encodeURIComponent(base64(packed))}`;
}

/** The read-only viewer page (for an iframe). Editing happens in the app (diagram-editor.tsx). */
export async function drawioViewerUrl(xml: string): Promise<string> {
  return `${DRAWIO_VIEWER}?lightbox=1&nav=1&border=10${await drawioHash(xml)}`;
}
