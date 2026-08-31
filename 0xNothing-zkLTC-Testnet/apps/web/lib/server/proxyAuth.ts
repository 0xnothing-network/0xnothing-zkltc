const TRUSTED_PROXY_SECRET_HEADER = "x-0xnothing-proxy-secret";
const MAX_PROXY_SECRET_LENGTH = 256;

function constantTimeStringEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

/**
 * Authenticate a request header injected by the trusted reverse proxy.
 * This implementation deliberately uses only Web/ECMAScript primitives so
 * Next middleware can stay on its default Edge runtime for Cloudflare OpenNext.
 */
export function trustedProxyRequest(
  request: Request,
  configuredSecret: string | undefined,
): boolean {
  const expected = configuredSecret?.trim();
  if (!expected) return true;
  if (expected.length > MAX_PROXY_SECRET_LENGTH) return false;

  const headerValue = request.headers.get(TRUSTED_PROXY_SECRET_HEADER);
  if (!headerValue || headerValue.length > MAX_PROXY_SECRET_LENGTH) return false;
  const presented = headerValue.trim();
  if (!presented) return false;
  return constantTimeStringEqual(expected, presented);
}
