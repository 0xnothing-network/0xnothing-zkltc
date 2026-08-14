import { PUMP_MAX_IMAGE_BYTES, validatePumpImage } from "@/features/pump/imageValidation";
import { normalizePumpIpfsPath } from "@/features/pump/config";
import sharp from "sharp";

export const runtime = "nodejs";

const CACHE_SECONDS = 31_536_000;
const GATEWAY_TIMEOUT_MS = 7_000;
const HEDGE_DELAY_MS = 650;
const MAX_REDIRECTS = 2;
const MAX_IMAGE_DIMENSION = 4_096;
const MAX_IMAGE_PIXELS = 4_194_304;

interface PumpImage {
  body: ArrayBuffer;
  contentType: string;
}

export async function GET(request: Request) {
  const rawCidPath = new URL(request.url).searchParams.get("cid") ?? "";
  const cidPath = normalizePumpIpfsPath(rawCidPath);
  if (!cidPath) return imageError("Invalid IPFS image CID", 400, 60);

  const etag = `"pump-${cidPath.replace(/[^a-zA-Z0-9._~-]/g, "-")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: imageHeaders(etag) });
  }

  const gateways = gatewayUrls(cidPath);
  const controllers = gateways.map(() => new AbortController());
  try {
    const attempts = gateways.map((url, index) =>
      fetchPumpImage(url, index * HEDGE_DELAY_MS, controllers[index]),
    );
    const image = await Promise.any(attempts);
    controllers.forEach((controller) => controller.abort());

    return new Response(image.body, {
      headers: {
        ...imageHeaders(etag),
        "Content-Length": image.body.byteLength.toString(),
        "Content-Type": image.contentType,
      },
    });
  } catch {
    controllers.forEach((controller) => controller.abort());
    return imageError("Token logo is temporarily unavailable", 404, 300);
  }
}

function gatewayUrls(cidPath: string): string[] {
  const [cid, ...pathSegments] = cidPath.split("/");
  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const gatewayPath = encodedPath ? `/${encodedPath}` : "";
  const urls = [
    `https://dweb.link/ipfs/${cid}${gatewayPath}`,
    `https://gateway.pinata.cloud/ipfs/${cid}${gatewayPath}`,
  ];

  // CIDv1 base32 is safe as a DNS label and avoids the extra path-gateway hop.
  if (cid.startsWith("b")) {
    urls.unshift(`https://${cid}.ipfs.dweb.link${gatewayPath || "/"}`);
  }
  return urls;
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

    const body = await readLimitedBody(response.body, PUMP_MAX_IMAGE_BYTES);
    const validationError = await validatePumpImage(new Blob([body], { type: contentType }));
    if (validationError) throw new Error(validationError);
    await validateImageDimensions(body);
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

async function validateImageDimensions(body: ArrayBuffer): Promise<void> {
  const metadata = await sharp(Buffer.from(body), {
    limitInputPixels: MAX_IMAGE_PIXELS,
    sequentialRead: true,
  }).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (
    width <= 0
    || height <= 0
    || width > MAX_IMAGE_DIMENSION
    || height > MAX_IMAGE_DIMENSION
    || width * height > MAX_IMAGE_PIXELS
    || (metadata.pages ?? 1) > 1
  ) {
    throw new Error("IPFS image dimensions are unsafe");
  }
}

async function readLimitedBody(stream: ReadableStream<Uint8Array>, limit: number): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new Error("IPFS image is too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output.buffer;
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
