import { hasUnsafeNameChars, IMAGE_TYPES, isUploadType } from '@saras/contracts';
import type { Response } from 'express';

// Safe file responses (doc 10 §10.5, T10). Never inline HTML or SVG: only allowlisted images are
// shown inline; everything else downloads as an attachment, with nosniff, a sandboxing CSP and a
// private cache. Types outside the allowlist (none can be stored) are sent as octet-stream.

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

/** A file name safe for Content-Disposition (ASCII fallback plus RFC 5987 UTF-8). */
export function contentDisposition(kind: 'inline' | 'attachment', name: string): string {
  const clean =
    [...name]
      .map((ch) => (hasUnsafeNameChars(ch) || ch === '"' ? '_' : ch))
      .join('')
      .slice(0, 200) || 'file';
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(clean)}`;
}

/** Headers for a stored file of `contentType`. */
export function fileHeaders(contentType: string, name: string): Record<string, string> {
  const allowed = isUploadType(contentType);
  const inline = allowed && IMAGE_TYPES.includes(contentType);
  const type = !allowed
    ? 'application/octet-stream'
    : TEXT_TYPES.has(contentType)
      ? `${contentType}; charset=utf-8`
      : contentType;
  return {
    'Content-Type': type,
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=300',
  };
}

export function sendFile(
  res: Response,
  file: { content: Buffer; contentType: string; name: string },
): void {
  res.status(200);
  for (const [name, value] of Object.entries(fileHeaders(file.contentType, file.name))) {
    res.setHeader(name, value);
  }
  res.setHeader('Content-Length', String(file.content.length));
  res.end(file.content);
}
