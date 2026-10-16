import { proxyStream } from '@/lib/stream-proxy';

// AI turn live text in an arena (SSE), streamed straight from the API (lib/stream-proxy.ts).

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; turnId: string }> },
): Promise<Response> {
  const { projectId, turnId } = await params;
  return proxyStream(
    request,
    `/v1/projects/${encodeURIComponent(projectId)}/arena/turns/${encodeURIComponent(turnId)}/events`,
  );
}
