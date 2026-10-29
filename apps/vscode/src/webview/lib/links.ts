// Link safety for chat messages: only http(s) links become clickable, and they open through the
// host (openUrl), never inside the webview.

/** The normalised URL when it is http or https, else undefined. */
export function safeHref(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
}
