// Local integration: preserve the existing workspace server on :3300 and serve
// the independent 0xPixel-Dogeos app from its loopback server on :3301.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function forward(request: Request) {
  const incoming = new URL(request.url);
  const upstream = new URL(incoming.pathname + incoming.search, 'http://127.0.0.1:3301');
  try {
    const response = await fetch(upstream, {
      method: request.method,
      headers: { 'Content-Type': request.headers.get('content-type') || 'application/json' },
      body: request.method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
    const headers = new Headers();
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'x-content-type-options']) {
      const value = response.headers.get(name); if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return new Response('DOGEOSxPIXEL is offline. Run npm start in 0xPixel-Dogeos (PORT=3301 while the workspace is on 3300).', { status: 503 });
  }
}
export const GET = forward;
export const POST = forward;
