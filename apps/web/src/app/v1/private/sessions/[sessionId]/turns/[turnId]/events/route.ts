import { proxyStream } from '@/lib/stream-proxy';

// AI turn live text in a private chat (SSE), streamed straight from the API (lib/stream-proxy.ts).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string; turnId: string }> },
): Promise<Response> {
  const { sessionId, turnId } = await params;
  return proxyStream(
    request,
    `/v1/private/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/events`,
  );
}
