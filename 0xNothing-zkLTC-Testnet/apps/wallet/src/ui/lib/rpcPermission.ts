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

/** The `host[:port]` named in the "needs your permission" note. */
export function rpcHost(rpcUrl: string): string {
  try {
    return new URL(rpcUrl).host;
  } catch {
    return rpcUrl;
  }
}

/**
 * True only when the extension can tell the RPC host is NOT granted. Loopback
 * moved to optional_host_permissions, and Chrome may drop the old grant of a
 * saved local RPC on update, so the UI asks again rather than failing reads.
 * No API, no pattern or a failed check is "not missing": never nag on a guess.
 */
export async function rpcAccessMissing(
  rpcUrl: string,
  permissions: { contains(request: { origins: string[] }): Promise<boolean> } | undefined,
): Promise<boolean> {
  const pattern = rpcPermissionPattern(rpcUrl);
  if (permissions === undefined || pattern === null) return false;
  try {
    return !(await permissions.contains({ origins: [pattern] }));
  } catch {
    return false;
  }
}
