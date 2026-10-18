// Strict JSONL framing for Pi's RPC protocol: records end with LF only. Node's readline is not used
// because it also splits on U+2028/U+2029, which are valid inside JSON strings.
import { StringDecoder } from 'node:string_decoder';

export class JsonlDecoder {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';

  /** Feed a chunk; returns every complete line (CR before LF stripped, blank lines skipped). */
  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean.trim() !== '') lines.push(clean);
    }
    return lines;
  }

  /** Flush whatever is left at end of stream. */
  end(): string[] {
    this.buffer += this.decoder.end();
    const rest = this.buffer;
    this.buffer = '';
    const clean = rest.endsWith('\r') ? rest.slice(0, -1) : rest;
    return clean.trim() === '' ? [] : [clean];
  }
}

export function serializeJsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
