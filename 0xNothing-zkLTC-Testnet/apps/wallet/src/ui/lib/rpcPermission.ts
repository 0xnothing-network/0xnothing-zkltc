/**
 * Derive the narrowest Chrome host-permission match pattern from a validated
 * RPC URL. A non-default port is deliberately retained so a local developer
 * node does not grant the extension access to every service on that host.
 */
export function rpcPermissionPattern(rpcUrl: string): string | null {
  try {
    const url = new URL(rpcUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.hostname.length === 0
      || url.hostname.includes("*")
      || url.username.length > 0
      || url.password.length > 0
    ) return null;
    return `${url.protocol}//${url.host}/*`;
  } catch {
    return null;
  }
}
