import { isIP } from "node:net";

/**
 * Reject hostnames that must never be contacted by server-side metadata fetches.
 * Direct IP literals are deliberately disallowed, including IPv4-mapped IPv6.
 */
export function isUnsafeRemoteHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!host || isIP(host) !== 0 || !host.includes(".")) return true;
  return host === "localhost"
    || host.endsWith(".localhost")
    || host.endsWith(".local")
    || host.endsWith(".internal")
    || host.endsWith(".home.arpa");
}
