import type { UploadType } from '@parallelflow/contracts';

// Upload type check (doc 10 §10.5, threat T10): the bytes must look like the type the client claims.
// Binary formats are checked by their magic bytes. Text formats must be valid UTF-8 with no NUL and
// must not start like a binary format, HTML or SVG (never served inline, but refused anyway).

const startsWith = (buf: Uint8Array, bytes: readonly number[], offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const GIF87 = ascii('GIF87a');
const GIF89 = ascii('GIF89a');
const RIFF = ascii('RIFF');
const WEBP = ascii('WEBP');
const PDF = ascii('%PDF-');

const BINARY_SIGNATURES: readonly (readonly number[])[] = [PNG, JPEG, GIF87, GIF89, PDF, RIFF];

/** Valid UTF-8 (fatal decoder), without NUL bytes. */
function isText(buf: Uint8Array): string | undefined {
  if (buf.includes(0)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return undefined;
  }
}

/** Markup a browser would render as a page or a script-capable image. */
const MARKUP = /^\s*(?:<!doctype\s+html|<html[\s>]|<svg[\s>]|<\?xml|<script[\s>])/i;

/** Whether `buf` is plausibly a file of the allowlisted type `claimed`. */
export function matchesType(buf: Uint8Array, claimed: UploadType): boolean {
  switch (claimed) {
    case 'image/png':
      return startsWith(buf, PNG);
    case 'image/jpeg':
      return startsWith(buf, JPEG);
    case 'image/gif':
      return startsWith(buf, GIF87) || startsWith(buf, GIF89);
    case 'image/webp':
      return startsWith(buf, RIFF) && startsWith(buf, WEBP, 8);
    case 'application/pdf':
      return startsWith(buf, PDF);
    case 'text/plain':
    case 'text/markdown':
    case 'text/csv':
    case 'application/json': {
      if (BINARY_SIGNATURES.some((sig) => startsWith(buf, sig))) return false;
      const text = isText(buf);
      if (text === undefined || MARKUP.test(text.replace(/^\uFEFF/, ''))) return false;
      if (claimed !== 'application/json') return true;
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    }
  }
}
