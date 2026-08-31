import { NextResponse } from "next/server";
import { verifyMessage, type Address, type Hex } from "viem";
import { zeroXPumpAbi } from "@/features/pump/abis";
import { computePumpContentHash } from "@/features/pump/contentHash";
import {
  PUMP_MAX_IMAGE_BYTES,
  validatePumpImage,
} from "@/features/pump/imageValidation";
import {
  isValidPumpExternalUrl,
  PUMP_CHAIN_ID,
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
} from "@/features/pump/config";
import {
  normalizePumpUploadMessage,
  parsePumpUploadMessage,
} from "@/features/pump/uploadMessage";
import { publicClient } from "@/lib/contract";
import { trustedProxyClientKey } from "@/lib/server/clientIp";
import { readLimitedBytes } from "@/lib/server/readLimitedBytes";
import { createSlidingWindowRateLimiter } from "@/lib/server/slidingWindowRateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_TTL_MS = 5 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_ATTEMPTS = 5;
const MAX_RATE_LIMIT_KEYS = 8_192;
// Keep multipart parsing bounded before Request.formData() allocates the body.
// The image limit is 2 MiB; the additional space covers form fields and
// multipart framing without allowing arbitrarily large request bodies.
const MAX_UPLOAD_BODY_BYTES = PUMP_MAX_IMAGE_BYTES + 512 * 1024;

const requestRateLimiter = createSlidingWindowRateLimiter({
  windowMs: RATE_WINDOW_MS,
  maxAttempts: RATE_MAX_ATTEMPTS,
  maxKeys: MAX_RATE_LIMIT_KEYS,
});
const consumedSignatures = new Map<string, number>();
const inFlightSignatures = new Set<string>();
const inFlightContentHashes = new Set<string>();

interface PinataV3Response {
  cid?: string;
  data?: {
    cid?: string;
  };
}

export async function GET() {
  if (!process.env.PINATA_JWT?.trim()) {
    return NextResponse.json(
      { configured: false, error: "IPFS uploads are not configured. Set PINATA_JWT on the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!PUMP_CONFIGURED) {
    return NextResponse.json(
      { configured: false, error: "0xPump is not configured. Set the deployed factory address first." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (process.env.NODE_ENV === "production" && !configuredUploadDomain()) {
    return NextResponse.json(
      { configured: false, error: "Set UPLOAD_SIGNING_DOMAIN to the public upload host." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { configured: true },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  const jwt = process.env.PINATA_JWT?.trim();
  if (!jwt) {
    return NextResponse.json(
      { error: "IPFS uploads are not configured. Set PINATA_JWT on the server." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!PUMP_CONFIGURED) {
    return NextResponse.json(
      { error: "0xPump is not configured. Set the deployed factory address first." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  const expectedDomain = uploadDomain(request);
  if (!expectedDomain) {
    return jsonError("IPFS uploads are not configured for this deployment", 503);
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("multipart/form-data;")) {
    return jsonError("Upload requests must use multipart form data", 415);
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_UPLOAD_BODY_BYTES) {
      return jsonError("Upload request is too large", 413);
    }
  }

  let form: FormData;
  try {
    const boundedBody = await readLimitedRequestBody(request.body, MAX_UPLOAD_BODY_BYTES);
    const replayableRequest = new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: boundedBody,
    });
    form = await replayableRequest.formData();
  } catch (error) {
    if (error instanceof UploadBodyTooLargeError) {
      return jsonError("Upload request is too large", 413);
    }
    return jsonError("Invalid multipart form data", 400);
  }

  const file = form.get("file");
  const message = normalizePumpUploadMessage(textField(form, "message"));
  const signature = textField(form, "signature");
  const submittedContentHash = textField(form, "contentHash").toLowerCase();
  const submittedAddress = textField(form, "address").toLowerCase();
  const name = textField(form, "name").trim();
  const symbol = textField(form, "symbol").trim().toUpperCase();
  const description = textField(form, "description").trim();
  const website = textField(form, "website").trim();
  const twitter = textField(form, "twitter").trim();

  if (!(file instanceof File)) return jsonError("A token logo is required", 400);
  if (!message || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return jsonError("A valid wallet signature is required", 401);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(submittedContentHash)) {
    return jsonError("Invalid content hash", 400);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(submittedAddress)) {
    return jsonError("Invalid wallet address", 400);
  }
  const nameBytes = new TextEncoder().encode(name).byteLength;
  if (nameBytes < 1 || nameBytes > 64) {
    return jsonError("Token name must contain 1 to 64 UTF-8 bytes", 400);
  }
  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
    return jsonError("Token symbol must contain 2 to 12 letters or numbers", 400);
  }
  if (description.length > 500) return jsonError("Description is too long", 400);
  if (website && !isValidPumpExternalUrl(website, 256)) return jsonError("Invalid website URL", 400);
  if (twitter && !isValidPumpExternalUrl(twitter, 256)) return jsonError("Invalid social URL", 400);

  const fields = parsePumpUploadMessage(message);
  if (!fields || fields.address.toLowerCase() !== submittedAddress) {
    return jsonError("Signed upload message does not match the wallet", 401);
  }
  if (fields.contentHash.toLowerCase() !== submittedContentHash) {
    return jsonError("Signed upload message does not match the content hash", 401);
  }

  if (fields.domain.toLowerCase() !== expectedDomain.toLowerCase()) {
    return jsonError("Signed upload domain does not match this application", 401);
  }
  if (fields.chainId !== PUMP_CHAIN_ID) {
    return jsonError("Signed upload message uses the wrong chain", 401);
  }

  const signedAt = Date.parse(fields.timestamp);
  const now = Date.now();
  if (!Number.isFinite(signedAt) || signedAt < now - SIGNATURE_TTL_MS || signedAt > now + FUTURE_CLOCK_SKEW_MS) {
    return jsonError("Signed upload message has expired", 401);
  }

  const address = fields.address as Address;
  let verified = false;
  try {
    verified = await verifyMessage({
      address,
      message,
      signature: signature as Hex,
    });
  } catch {
    verified = false;
  }
  if (!verified) return jsonError("Wallet signature verification failed", 401);

  pruneTransientState(now);
  const signatureKey = signature.toLowerCase();
  if (consumedSignatures.has(signatureKey) || inFlightSignatures.has(signatureKey)) {
    return jsonError("This upload authorization has already been used", 409);
  }

  const ip = clientIp(request);
  const rateKeys = [`wallet:${submittedAddress}`, `ip:${ip}`];
  if (!requestRateLimiter.consume(rateKeys, now)) {
    return NextResponse.json(
      { error: "Upload rate limit reached. Wait before trying again." },
      {
        status: 429,
        headers: { "Cache-Control": "no-store", "Retry-After": "600" },
      },
    );
  }

  const validationError = await validatePumpImage(file);
  if (validationError) return jsonError(validationError, 400);

  const computedContentHash = await computePumpContentHash({
    chainId: PUMP_CHAIN_ID,
    factory: PUMP_FACTORY_ADDRESS,
    owner: address,
    name,
    symbol,
    description,
    website,
    twitter,
    file,
  });
  if (computedContentHash.toLowerCase() !== submittedContentHash) {
    return jsonError("Uploaded content does not match the signed content hash", 401);
  }

  let reserved = false;
  try {
    reserved = await publicClient.readContract({
      address: PUMP_FACTORY_ADDRESS,
      abi: zeroXPumpAbi,
      functionName: "creationReservations",
      args: [address, computedContentHash],
    });
  } catch (error) {
    console.error("[ipfs/upload] Reservation check failed:", error);
    return jsonError("Could not verify the on-chain creation reservation", 503);
  }
  if (!reserved) {
    return jsonError("Pay the $1 creation reservation before uploading", 403);
  }

  const contentKey = `${submittedAddress}:${submittedContentHash}`;
  if (inFlightContentHashes.has(contentKey)) {
    return jsonError("This reserved content is already being uploaded", 409);
  }
  inFlightSignatures.add(signatureKey);
  inFlightContentHashes.add(contentKey);
  try {
    const imageCid = await pinFile(jwt, file, `${symbol.toLowerCase()}-logo`);
    const imageURI = `ipfs://${imageCid}`;
    const metadata = canonicalMetadata({
      name,
      symbol,
      description,
      imageURI,
      website,
      twitter,
    });
    const metadataCid = await pinJson(jwt, metadata, `${symbol.toLowerCase()}-metadata`);
    const metadataURI = `ipfs://${metadataCid}`;
    consumedSignatures.set(signatureKey, now);

    return NextResponse.json(
      {
        imageCid,
        imageURI,
        metadataCid,
        metadataURI,
      },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[ipfs/upload] Pinata upload failed:", error);
    return jsonError("IPFS upload failed. Please retry.", 502);
  } finally {
    inFlightSignatures.delete(signatureKey);
    inFlightContentHashes.delete(contentKey);
  }
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

class UploadBodyTooLargeError extends Error {}

async function readLimitedRequestBody(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Blob> {
  if (!stream) throw new Error("Upload request has no body");
  const body = await readLimitedBytes(stream, limit, () => new UploadBodyTooLargeError());
  return new Blob([body.buffer as ArrayBuffer]);
}

function uploadDomain(request: Request): string {
  const configured = configuredUploadDomain();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") return "";
  return new URL(request.url).host.toLowerCase();
}

function configuredUploadDomain(): string | null {
  const configured = process.env.UPLOAD_SIGNING_DOMAIN?.trim();
  return configured ? normalizeUploadDomain(configured) : null;
}

function clientIp(request: Request): string {
  // Only use forwarding headers when the deployment explicitly guarantees
  // that its proxy overwrites the selected header. Otherwise they are
  // attacker-controlled and would make the IP rate limit trivial to bypass.
  return trustedProxyClientKey(
    request,
    process.env.UPLOAD_TRUSTED_PROXY_CLIENT_IP_HEADER,
    process.env.VERCEL === "1",
    process.env.TRUSTED_PROXY_SHARED_SECRET,
    process.env.CLOUDFLARE_WORKERS === "true",
  );
}

function normalizeUploadDomain(value: string): string | null {
  const raw = value.trim();
  if (!raw || raw.length > 255) return null;
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
    ) return null;
    return parsed.host.toLowerCase();
  } catch {
    return null;
  }
}

function pruneTransientState(now: number) {
  requestRateLimiter.prune(now);
  for (const [signature, timestamp] of consumedSignatures) {
    if (timestamp <= now - SIGNATURE_TTL_MS) consumedSignatures.delete(signature);
  }
}

function canonicalMetadata(input: {
  name: string;
  symbol: string;
  description: string;
  imageURI: string;
  website: string;
  twitter: string;
}) {
  return {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    image: input.imageURI,
    external_url: input.website || undefined,
    properties: {
      platform: "0xPump",
      twitter: input.twitter || undefined,
    },
  };
}

async function pinFile(jwt: string, file: File, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", file, safeFileName(file.name, name));
  form.append("network", "public");
  form.append("name", name);

  const response = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  return pinataCid(response);
}

async function pinJson(
  jwt: string,
  content: ReturnType<typeof canonicalMetadata>,
  name: string,
): Promise<string> {
  const metadataFile = new File(
    [JSON.stringify(content)],
    `${name}.json`,
    { type: "application/json" },
  );
  return pinFile(jwt, metadataFile, name);
}

async function pinataCid(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`Pinata returned HTTP ${response.status}`);
  const payload = (await response.json()) as PinataV3Response;
  const cid = payload.data?.cid ?? payload.cid;
  if (!cid || !/^[a-zA-Z0-9]+$/.test(cid)) {
    throw new Error("Pinata response did not contain a CID");
  }
  return cid;
}

function safeFileName(original: string, fallback: string): string {
  const extension = original.toLowerCase().match(/\.(png|jpe?g|webp|json)$/)?.[0] ?? "";
  return `${fallback.replace(/[^a-zA-Z0-9_-]/g, "-")}${extension}`;
}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
