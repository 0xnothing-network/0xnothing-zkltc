// Local development uses :3301; deployed workspaces configure the Node service
// origin with DOGEOS_PIXEL_ORIGIN. The service serves the same /DOGEOSxPIXEL path.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const base = '/DOGEOSxPIXEL';
const maxBodyBytes = 64 * 1024;
async function bodyFor(request: Request): Promise<Uint8Array | undefined> {
  if (request.method !== 'POST' || !request.body) return undefined;
  if (Number(request.headers.get('content-length')) > maxBodyBytes) throw new RangeError('Request body too large.');
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) { await reader.cancel(); throw new RangeError('Request body too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
async function forward(request: Request) {
  const incoming = new URL(request.url);
  if (incoming.pathname !== base && !incoming.pathname.startsWith(base + '/')) return new Response('Not found.', { status: 404 });
  try {
    const configured = process.env.DOGEOS_PIXEL_ORIGIN?.trim();
    if (!configured && process.env.NODE_ENV === 'production') throw new Error('DOGEOS_PIXEL_ORIGIN is required in production.');
    const origin = new URL(configured || 'http://127.0.0.1:3301');
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin === incoming.origin) throw new Error('Invalid DOGEOS_PIXEL_ORIGIN.');
    const upstream = new URL(incoming.pathname + incoming.search, origin);
    const body = await bodyFor(request);
    const response = await fetch(upstream, {
      method: request.method,
      headers: { 'Content-Type': request.headers.get('content-type') || 'application/json' },
      body: body as BodyInit | undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
    const headers = new Headers();
    for (const name of ['content-type', 'cache-control', 'etag', 'last-modified', 'x-content-type-options', 'referrer-policy']) {
      const value = response.headers.get(name); if (value) headers.set(name, value);
    }
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (error instanceof RangeError) return new Response('Request body too large.', { status: 413 });
    console.error('DOGEOSxPIXEL upstream unavailable. Check DOGEOS_PIXEL_ORIGIN and the Node service.');
    return new Response('DOGEOS × PIXEL is temporarily unavailable. Please try again shortly.', { status: 503 });
  }
}
export const GET = forward;
export const POST = forward;
export const HEAD = forward;
