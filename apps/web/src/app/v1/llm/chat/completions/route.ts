import { serverApiUrl } from '../../../../../lib/config';

// The extension's LLM proxy through the web origin (ADR-037). The /v1 rewrite buffers and times out
// at 30 s, which a streamed answer cannot live with, so this route passes the request (with its
// bearer token) to the API and streams the answer back unbuffered. Nothing here reads or logs it.

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${serverApiUrl()}/v1/llm/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: request.headers.get('authorization') ?? '',
        'content-type': request.headers.get('content-type') ?? 'application/json',
        accept: request.headers.get('accept') ?? 'application/json',
      },
      body: await request.arrayBuffer(),
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    return Response.json(
      { error: { message: 'Could not reach ParallelFlow.', type: 'unavailable', code: 'unavailable' } },
      { status: 502 },
    );
  }
  const headers = new Headers({
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  for (const name of ['ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
