// An uploaded file as text for the AI (files.read). Text types are decoded as UTF-8; a PDF's text is
// extracted with unpdf (pure JS, no native code); images and anything else are not readable as text.
// Content is never logged.

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

export interface FileText {
  /** null = not readable as text (see `note`). */
  text: string | null;
  note?: string;
}

export async function fileText(contentType: string, content: Buffer | null): Promise<FileText> {
  if (!content) return { text: null, note: 'The file content is not stored here.' };
  if (TEXT_TYPES.has(contentType)) return { text: content.toString('utf8') };
  if (contentType === 'application/pdf') {
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(content));
      const { text } = await extractText(pdf, { mergePages: true });
      const value = Array.isArray(text) ? text.join('\n\n') : text;
      return value.trim()
        ? { text: value }
        : { text: null, note: 'This PDF has no text layer (it may be scanned images).' };
    } catch {
      return { text: null, note: 'This PDF could not be read.' };
    }
  }
  if (contentType.startsWith('image/')) {
    return { text: null, note: 'This is an image; its pixels cannot be read as text here.' };
  }
  return { text: null, note: 'This file type cannot be read as text.' };
}
