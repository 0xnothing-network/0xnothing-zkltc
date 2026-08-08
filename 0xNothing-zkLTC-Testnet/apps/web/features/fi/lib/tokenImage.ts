const MAX_TOKEN_IMAGE_URI_LENGTH = 2_048;

const TRUSTED_IMAGE_HOSTS = new Set([
  "dweb.link",
  "ipfs.io",
  "gateway.pinata.cloud",
]);

const TRUSTED_IMAGE_HOST_SUFFIXES = [
  ".ipfs.dweb.link",
  ".ipfs.io",
  ".mypinata.cloud",
];

function isTrustedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TRUSTED_IMAGE_HOSTS.has(host)
    || TRUSTED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length);
}

/**
 * Converts supported immutable token metadata URIs into a browser-safe HTTPS URL.
 * Arbitrary remote URLs are rejected because pump token metadata is user-controlled.
 */
export function tokenImageUrl(uri: string | undefined): string | undefined {
  const value = uri?.trim();
  if (!value || value.length > MAX_TOKEN_IMAGE_URI_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }

  const candidate = value.startsWith("ipfs://")
    ? (() => {
        const path = value.slice("ipfs://".length).replace(/^ipfs\//, "").replace(/^\/+/, "");
        return path ? `https://dweb.link/ipfs/${path}` : undefined;
      })()
    : value;

  if (!candidate) return undefined;

  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || !isTrustedImageHost(parsed.hostname)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}
