const MAX_EXTERNAL_HREF_LENGTH = 2_048;

export const FIRST_PARTY_EXTERNAL_REL = "noopener noreferrer";
export const USER_EXTERNAL_REL = "noopener noreferrer nofollow ugc";

function isIpv4Literal(hostname: string): boolean {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return false;
  return hostname.split(".").every((octet) => {
    if (octet.length > 1 && octet.startsWith("0")) return true;
    const n = Number(octet);
    return n >= 0 && n <= 255;
  });
}

/**
 * Browser-safe hostname policy for user-supplied https links. IP literals,
 * local names, and credentialed URLs are rejected so a metadata field cannot
 * become a javascript: or intranet trap.
 */
export function isUnsafeExternalHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!host || !host.includes(".")) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    return true;
  }
  if (isIpv4Literal(host) || host.includes(":")) return true;
  return false;
}

export function normalizeExternalHref(
  value: string,
  maxLength = MAX_EXTERNAL_HREF_LENGTH,
): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return "";
    if (url.username || url.password) return "";
    if (url.port && url.port !== "443") return "";
    if (isUnsafeExternalHostname(url.hostname)) return "";
    return url.href;
  } catch {
    return "";
  }
}

export function isValidExternalHref(value: string, maxLength = MAX_EXTERNAL_HREF_LENGTH): boolean {
  return Boolean(normalizeExternalHref(value, maxLength));
}
