import { PUMP_MAX_IMAGE_BYTES, validatePumpImage } from "@/features/pump/imageValidation";
import { normalizePumpIpfsPath } from "@/features/pump/config";
import { createBoundedCache } from "@/lib/boundedCache";
import { readLimitedBytes } from "@/lib/server/readLimitedBytes";
import {
  hasSafeRasterDimensions,
  readRasterImageMetadata,
} from "@/lib/server/rasterImageMetadata";

export const runtime = "nodejs";

const CACHE_SECONDS = 31_536_000;
// A logo is capped at 2 MB, so a gateway that has not answered in this window is
// stalled rather than slow. The old 25 s budget held a market grid's connections
// open long after the browser had anything to paint.
const GATEWAY_TIMEOUT_MS = 10_000;
const HEDGE_DELAY_MS = 650;
const MAX_REDIRECTS = 2;
const MAX_IMAGE_DIMENSION = 4_096;
const MAX_IMAGE_PIXELS = 4_194_304;
// Long enough that one dead CID cannot re-enter the full gateway wait on every
// grid render, short enough that a freshly pinned CID still appears quickly.
const FAILURE_BACKOFF_MS = 20_000;
const MAX_FAILURE_CACHE_ENTRIES = 512;

interface PumpImage {
  body: ArrayBuffer;
  contentType: string;
}

// Concurrent requests for one CID share a single gateway fetch. The zero ttl keeps
// image bodies out of memory: only the in-flight promise is tracked.
const imageLoads = createBoundedCache<PumpImage>({
  maxEntries: 1,
  ttlMs: 0,
  maxInFlight: MAX_FAILURE_CACHE_ENTRIES,
});
// A CID that just failed every gateway is answered from the fallback for the backoff
// window instead of retrying on each render.
const imageFailures = createBoundedCache<true>({
  maxEntries: MAX_FAILURE_CACHE_ENTRIES,
  ttlMs: FAILURE_BACKOFF_MS,
});

export async function GET(request: Request) {
  const searchParams = new URL(request.url).searchParams;
  const rawCidPath = searchParams.get("cid") ?? "";
  const cidPath = normalizePumpIpfsPath(rawCidPath);
  if (!cidPath) return imageError("Invalid IPFS image CID", 400, 60);
  const symbol = normalizeFallbackSymbol(searchParams.get("symbol") ?? "");

  const etag = `"pump-${cidPath.replace(/[^a-zA-Z0-9._~-]/g, "-")}"`;
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: imageHeaders(etag) });
  }

  if (imageFailures.get(cidPath)) return fallbackImage(symbol);

  try {
    const image = await imageLoads.refresh(cidPath, () => loadPumpImage(cidPath));
    imageFailures.delete(cidPath);

    return new Response(image.body, {
      headers: {
        ...imageHeaders(etag),
        "Content-Length": image.body.byteLength.toString(),
        "Content-Type": image.contentType,
      },
    });
  } catch {
    imageFailures.set(cidPath, true);
    return fallbackImage(symbol);
  }
}

async function loadPumpImage(cidPath: string): Promise<PumpImage> {
  const gateways = gatewayUrls(cidPath);
  const controllers = gateways.map(() => new AbortController());
  try {
    const attempts = gateways.map((url, index) =>
      fetchPumpImage(url, index * HEDGE_DELAY_MS, controllers[index]),
    );
    return await Promise.any(attempts);
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
}

function gatewayUrls(cidPath: string): string[] {
  const [cid, ...pathSegments] = cidPath.split("/");
  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const gatewayPath = encodedPath ? `/${encodedPath}` : "";
  const pinataUrl = `https://gateway.pinata.cloud/ipfs/${cid}${gatewayPath}`;

  // A dweb.link path request redirects to this same subdomain. Do not fetch
  // both forms for every logo: a market grid would otherwise duplicate all
  // dweb.link traffic and make cold IPFS retrievals more likely to time out.
  if (cid.startsWith("b")) {
    return [
      `https://${cid}.ipfs.dweb.link${gatewayPath || "/"}`,
      pinataUrl,
    ];
  }
  return [
    `https://dweb.link/ipfs/${cid}${gatewayPath}`,
    pinataUrl,
  ];
}

async function fetchPumpImage(
  url: string,
  delayMs: number,
  controller: AbortController,
): Promise<PumpImage> {
  if (delayMs > 0) await abortableDelay(delayMs, controller.signal);
  const timeout = setTimeout(() => controller.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const response = await fetchAllowedGateway(url, controller.signal);
    if (!response.ok || !response.body) throw new Error("IPFS gateway unavailable");

    const contentType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > PUMP_MAX_IMAGE_BYTES) throw new Error("IPFS image is too large");

    const bytes = await readLimitedBytes(
      response.body,
      PUMP_MAX_IMAGE_BYTES,
      () => new Error("IPFS image is too large"),
    );
    const body = bytes.buffer as ArrayBuffer;
    const validationError = await validatePumpImage(new Blob([body], { type: contentType }));
    if (validationError) throw new Error(validationError);
    validateImageDimensions(body, contentType);
    return { body, contentType };
  } catch (error) {
    controller.abort();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllowedGateway(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let currentUrl = new URL(initialUrl);
  assertAllowedGateway(currentUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetch(currentUrl, {
      cache: "no-store",
      headers: { Accept: "image/webp,image/png,image/jpeg" },
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location || redirects === MAX_REDIRECTS) throw new Error("Unsafe IPFS gateway redirect");
    currentUrl = new URL(location, currentUrl);
    assertAllowedGateway(currentUrl);
  }

  throw new Error("Too many IPFS gateway redirects");
}

function assertAllowedGateway(url: URL): void {
  const hostname = url.hostname.toLowerCase();
  const allowed = hostname === "dweb.link"
    || hostname === "gateway.pinata.cloud"
    || hostname.endsWith(".ipfs.dweb.link");
  if (
    url.protocol !== "https:"
    || !allowed
    || url.username
    || url.password
    || (url.port && url.port !== "443")
  ) {
    throw new Error("IPFS gateway redirect escaped the allowlist");
  }
}

function validateImageDimensions(body: ArrayBuffer, contentType: string): void {
  const metadata = readRasterImageMetadata(new Uint8Array(body), contentType);
  if (!hasSafeRasterDimensions(metadata, MAX_IMAGE_DIMENSION, MAX_IMAGE_PIXELS)) {
    throw new Error("IPFS image dimensions are unsafe");
  }
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function imageHeaders(etag: string): Record<string, string> {
  return {
    "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, immutable`,
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  };
}

/**
 * If-None-Match is a list and uses weak comparison, so an intermediary that
 * rewrote the strong tag to `W/"..."` must still get a 304 instead of a full
 * gateway round trip.
 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const trimmed = header.trim();
  if (trimmed === "*") return true;
  return trimmed
    .split(",")
    .some((candidate) => candidate.trim().replace(/^W\//, "") === etag);
}

function imageError(message: string, status: number, maxAge: number) {
  return Response.json(
    { error: message },
    {
      status,
      headers: {
        "Cache-Control": `public, max-age=${maxAge}, s-maxage=${maxAge}`,
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function normalizeFallbackSymbol(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
}

/**
 * Keep a temporarily unavailable immutable asset from becoming a failed
 * browser resource. This response is intentionally not cached so a later
 * request can replace it as soon as either IPFS gateway has the content.
 */
function fallbackImage(symbol: string): Response {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96">',
    '<rect width="96" height="96" fill="#15191c"/>',
    '<path d="M0 0h48v48H0zm48 48h48v48H48z" fill="#242b2f"/>',
    `<text x="48" y="51" fill="#77ffb1" font-family="ui-monospace,monospace" font-size="24" font-weight="700" text-anchor="middle" dominant-baseline="middle">${symbol}</text>`,
    "</svg>",
  ].join("");
  return new Response(svg, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "image/svg+xml; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Pump-Image-Fallback": "1",
    },
  });
}
