// A Server-Sent Events parser (WHATWG "event stream interpretation"), for the runtime's turn events.
// Frames are yielded as they complete; data is never logged.

export interface SseFrame {
  /** The last `id:` seen so far (the resume point), if any. */
  id?: string;
  event: string;
  data: string;
}

/** Parses a byte stream into SSE frames. */
export async function* parseSse(
  body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event = '';
  let lastId: string | undefined;

  const field = (line: string): SseFrame | undefined => {
    if (line === '') {
      if (data.length === 0) {
        event = '';
        return undefined;
      }
      const frame: SseFrame = { event: event || 'message', data: data.join('\n') };
      if (lastId !== undefined) frame.id = lastId;
      data = [];
      event = '';
      return frame;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') data.push(value);
    else if (name === 'event') event = value;
    else if (name === 'id' && !value.includes('\0')) lastId = value;
    return undefined;
  };

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    // Lines end with CRLF, LF or CR. A trailing CR may be the first half of a CRLF: keep it.
    for (;;) {
      const match = /\r\n|\n|\r(?=[^\n])/.exec(buffer);
      if (!match) break;
      const line = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const frame = field(line);
      if (frame) yield frame;
    }
  }
  // An unterminated final frame is dropped (spec): only blank-line-terminated frames dispatch.
}
