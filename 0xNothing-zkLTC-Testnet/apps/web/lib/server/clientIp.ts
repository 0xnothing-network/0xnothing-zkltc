import { isIP } from "node:net";

const TRUSTED_HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * Parse the address formats commonly emitted by reverse proxies without ever
 * accepting a non-IP token as a rate-limit key.
 */
export function normalizeIp(value: string | null): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim().replace(/^"|"$/g, "");
  if (!candidate) return undefined;

  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket > 1) candidate = candidate.slice(1, closingBracket);
  } else if (isIP(candidate) === 0) {
    const separator = candidate.lastIndexOf(":");
    if (separator > 0 && /^\d+$/.test(candidate.slice(separator + 1))) {
      const withoutPort = candidate.slice(0, separator);
      if (isIP(withoutPort) !== 0) candidate = withoutPort;
    }
  }

  return isIP(candidate) !== 0 ? candidate.toLowerCase() : undefined;
}

/** Select the proxy-adjacent address from a comma-separated forwarding chain. */
export function rightmostForwardedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  const entries = value.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeIp(entries[index]);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * Build a non-spoofable client key. Forwarding headers are ignored unless the
 * deployment explicitly opts into one header or runs behind Vercel.
 */
export function trustedProxyClientKey(
  request: Request,
  configuredHeaderValue: string | undefined,
  useVercelHeaders: boolean,
): string {
  const configuredHeader = configuredHeaderValue?.trim().toLowerCase();
  if (configuredHeader && TRUSTED_HEADER_NAME.test(configuredHeader)) {
    const value = request.headers.get(configuredHeader);
    const address = configuredHeader.includes("forwarded")
      ? rightmostForwardedIp(value)
      : normalizeIp(value);
    if (address) return `${configuredHeader}:${address}`;
  }

  if (useVercelHeaders) {
    const address = rightmostForwardedIp(request.headers.get("x-vercel-forwarded-for"))
      ?? rightmostForwardedIp(request.headers.get("x-forwarded-for"))
      ?? normalizeIp(request.headers.get("x-real-ip"));
    if (address) return `vercel:${address}`;
  }

  return "unidentified-client";
}
