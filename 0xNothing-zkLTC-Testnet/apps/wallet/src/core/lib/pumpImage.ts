import { PUBLIC_APP_URL } from "../../config/dapps.ts";

const MAX_IMAGE_URI_LENGTH = 2_048;
const PUBLIC_APP_ORIGIN = new URL(PUBLIC_APP_URL).origin;
const CID_V0_PATTERN = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32_PATTERN = /^b[a-z2-7]{20,}$/i;
const IPFS_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9._~-]{1,128}$/;
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

/**
 * Converts the immutable image URI emitted by a 0xPump token into a safe image
 * source. IPFS is served through the site's bounded proxy; arbitrary URLs are
 * never accepted just because a token contract returned them.
 */
export function pumpTokenImageUrl(uri: string | undefined, symbol = ""): string | undefined {
  const value = uri?.trim();
  if (!value || value.length > MAX_IMAGE_URI_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }

  // Built-in assets are shipped with the wallet and are not remote input.
  if (/^tokens\/[a-zA-Z0-9._~-]+$/.test(value)) return value;

  // 0xFi's pool catalog already returns the same bounded proxy as a relative
  // URL. Re-validate its CID and rebuild it against the public app origin so an
  // extension page never treats an arbitrary relative URL as an image source.
  const existingProxyPath = publicProxyCidPath(value);
  if (existingProxyPath) return proxyImageUrl(existingProxyPath, symbol);

  const directIpfsPath = /^ipfs:\/\//i.test(value) || /^ipfs\//i.test(value)
    ? normalizeIpfsPath(value)
    : "";
  if (directIpfsPath) return proxyImageUrl(directIpfsPath, symbol);

  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (
      parsed.protocol !== "https:"
      || parsed.username
      || parsed.password
      || (parsed.port && parsed.port !== "443")
      || (!TRUSTED_IMAGE_HOSTS.has(host)
        && !TRUSTED_IMAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length))
    ) {
      return undefined;
    }

    const cidPath = gatewayCidPath(parsed);
    return cidPath ? proxyImageUrl(cidPath, symbol) : parsed.toString();
  } catch {
    return undefined;
  }
}

function proxyImageUrl(cidPath: string, symbol: string): string {
  const params = new URLSearchParams({ cid: cidPath });
  const initials = symbol.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase();
  if (initials) params.set("symbol", initials);
  return `${PUBLIC_APP_URL}/api/pump/image?${params.toString()}`;
}

function normalizeIpfsPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512) return "";
  const withoutScheme = trimmed.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
  if (!withoutScheme || /[%?#\\]/.test(withoutScheme)) return "";
  const segments = withoutScheme.split("/");
  const cid = segments.shift() ?? "";
  if (!CID_V0_PATTERN.test(cid) && !CID_V1_BASE32_PATTERN.test(cid)) return "";
  if (
    segments.length > 8
    || segments.some(
      (segment) => segment === "." || segment === ".." || !IPFS_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    return "";
  }
  return [cid.startsWith("Qm") ? cid : cid.toLowerCase(), ...segments].join("/");
}

function publicProxyCidPath(value: string): string {
  try {
    const parsed = new URL(value, PUBLIC_APP_URL);
    if (
      parsed.origin !== PUBLIC_APP_ORIGIN
      || parsed.pathname !== "/api/pump/image"
      || parsed.hash
    ) return "";
    return normalizeIpfsPath(parsed.searchParams.get("cid") ?? "");
  } catch {
    return "";
  }
}

function gatewayCidPath(url: URL): string {
  if (url.search || url.hash) return "";
  const host = url.hostname.toLowerCase();
  const subdomainMarker = host.indexOf(".ipfs.");
  if (subdomainMarker > 0) {
    const cid = host.slice(0, subdomainMarker);
    const path = url.pathname.replace(/^\/+/, "");
    return normalizeIpfsPath(path ? `${cid}/${path}` : cid);
  }
  const pathMatch = url.pathname.match(/^\/ipfs\/(.+)$/i);
  const path = pathMatch?.[1];
  return path ? normalizeIpfsPath(path) : "";
}
