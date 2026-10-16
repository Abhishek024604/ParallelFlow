import { serverApiUrl } from './config';

// AI turn live text (SSE), streamed straight from the API. Route handlers take precedence over the
// /v1/* rewrite in next.config.ts (a `fallback` rewrite, which runs after dynamic routes): the rewrite
// proxy buffers and times out at 30 s, which a stream cannot live with. Cookies go along as the
// browser sent them; the API checks access. Nothing here reads or logs the stream.

export async function proxyStream(request: Request, path: string): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${serverApiUrl()}${path}`, {
      headers: {
        cookie: request.headers.get('cookie') ?? '',
        accept: 'text/event-stream',
      },
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    return Response.json(
      { code: 'UNAVAILABLE', detail: 'Could not reach Saras.' },
      { status: 502, headers: { 'content-type': 'application/problem+json' } },
    );
  }
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  for (const cookie of upstream.headers.getSetCookie()) headers.append('set-cookie', cookie);
  return new Response(upstream.body, { status: upstream.status, headers });
}
