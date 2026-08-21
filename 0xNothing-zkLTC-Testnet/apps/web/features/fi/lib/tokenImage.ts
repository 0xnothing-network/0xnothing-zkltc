import { normalizePumpIpfsPath } from "@/features/pump/config";

const MAX_TOKEN_IMAGE_URI_LENGTH = 2_048;
const IMAGE_PROXY_PATH = "/api/pump/image";

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
 * Converts supported immutable token metadata URIs into a browser-safe image URL.
 * IPFS gateway URLs are normalized through the same-origin image proxy so remote
 * CORP/CORS policies cannot block token logos in the browser.
 */
export function tokenImageUrl(uri: string | undefined, symbol = ""): string | undefined {
  const value = uri?.trim();
  if (!value || value.length > MAX_TOKEN_IMAGE_URI_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }

  const directIpfsPath = value.toLowerCase().startsWith("ipfs://")
    ? normalizePumpIpfsPath(value)
    : "";
  if (directIpfsPath) return proxyImageUrl(directIpfsPath, symbol);

  const existingProxyPath = proxyCidPath(value);
  if (existingProxyPath) return proxyImageUrl(existingProxyPath, symbol);

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || !isTrustedImageHost(parsed.hostname)
    ) {
      return undefined;
    }

    const gatewayIpfsPath = gatewayCidPath(parsed);
    if (gatewayIpfsPath) return proxyImageUrl(gatewayIpfsPath, symbol);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function proxyImageUrl(cidPath: string, symbol: string): string {
  const params = new URLSearchParams({ cid: cidPath });
  const initials = symbol.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  if (initials) params.set("symbol", initials);
  return `${IMAGE_PROXY_PATH}?${params.toString()}`;
}

function proxyCidPath(value: string): string {
  if (!value.startsWith(`${IMAGE_PROXY_PATH}?`)) return "";
  try {
    const parsed = new URL(value, "https://same-origin.invalid");
    return parsed.pathname === IMAGE_PROXY_PATH
      ? normalizePumpIpfsPath(parsed.searchParams.get("cid") ?? "")
      : "";
  } catch {
    return "";
  }
}

function gatewayCidPath(url: URL): string {
  if (url.search || url.hash) return "";

  const hostname = url.hostname.toLowerCase();
  const subdomainMarker = hostname.indexOf(".ipfs.");
  if (subdomainMarker > 0) {
    const cid = hostname.slice(0, subdomainMarker);
    const path = url.pathname.replace(/^\/+/, "");
    return normalizePumpIpfsPath(path ? `${cid}/${path}` : cid);
  }

  const pathMatch = url.pathname.match(/^\/ipfs\/(.+)$/i);
  return pathMatch ? normalizePumpIpfsPath(pathMatch[1]) : "";
}
