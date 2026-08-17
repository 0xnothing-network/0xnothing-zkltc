import { NextResponse } from "next/server";
import { isIP } from "node:net";
import {
  createPublicClient,
  http,
  verifyMessage,
  type Address,
  type Hex,
} from "viem";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_TTL_MS = 5 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_ATTEMPTS = 5;
const MAX_RATE_LIMIT_KEYS = 8_192;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MIN_IMAGE_BYTES = 100;
// Keep multipart parsing bounded before Request.formData() allocates the body.
// The image limit is 2 MiB; the additional space covers form fields and
// multipart framing without allowing arbitrarily large request bodies.
const MAX_UPLOAD_BODY_BYTES = MAX_IMAGE_BYTES + 512 * 1024;

const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

const ownableAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const client = createPublicClient({
  transport: http(deployment.chain.rpcUrl, {
    retryCount: 1,
    retryDelay: 250,
    timeout: 7_500,
  }),
});

const requestHistory = new Map<string, number[]>();
const consumedSignatures = new Map<string, number>();
const inFlightSignatures = new Set<string>();

interface PinataV3Response {
  cid?: string;
  data?: {
    cid?: string;
  };
}

interface FiUploadMessageFields {
  address: Address;
  tokenAddress: Address;
  domain: string;
  chainId: number;
  timestamp: string;
}

export async function GET() {
  if (!process.env.PINATA_JWT?.trim()) {
    return NextResponse.json(
      { configured: false, error: "IPFS uploads are not configured. Set PINATA_JWT on the server." },
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
  const message = normalizeUploadMessage(textField(form, "message"));
  const signature = textField(form, "signature");
  const tokenAddress = textField(form, "tokenAddress").toLowerCase();

  if (!(file instanceof File)) return jsonError("A token logo is required", 400);
  if (!message) {
    return jsonError("A signed upload message is required", 400);
  }
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return jsonError("A valid wallet signature is required", 401);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) {
    return jsonError("Invalid token contract address", 400);
  }

  const fields = parseUploadMessage(message);
  if (!fields) {
    return jsonError("Invalid signed upload message", 400);
  }
  if (fields.tokenAddress.toLowerCase() !== tokenAddress) {
    return jsonError("Signed upload message does not match the token address", 401);
  }

  if (fields.domain.toLowerCase() !== expectedDomain.toLowerCase()) {
    return jsonError("Signed upload domain does not match this application", 401);
  }
  if (fields.chainId !== deployment.chain.id) {
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
  const rateKeys = [`wallet:${address.toLowerCase()}`, `ip:${ip}`];
  for (const key of rateKeys) {
    if (!consumeRateLimit(key, now)) {
      return NextResponse.json(
        { error: "Upload rate limit reached. Wait before trying again." },
        {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "600" },
        },
      );
    }
  }

  const validationError = validateImage(file);
  if (validationError) return jsonError(validationError, 400);

  // Verify that the signing wallet owns the token contract. Only the owner
  // of a token may set its logo. The check is permissive about the shape of
  // `owner()` so it works with standard Ownable and custom tokens alike.
  let isOwner = false;
  try {
    isOwner = await checkTokenOwner(fields.tokenAddress as Address, address);
  } catch (error) {
    console.error("[0xFi/ipfs/upload] Token owner check failed:", error);
    return jsonError("Could not verify token ownership", 503);
  }
  if (!isOwner) {
    return jsonError("Only the token owner can upload a logo", 403);
  }

  inFlightSignatures.add(signatureKey);
  try {
    const imageCid = await pinFile(jwt, file, `${tokenAddress.slice(2, 10)}-logo`);
    const imageURI = `ipfs://${imageCid}`;
    consumedSignatures.set(signatureKey, now);

    return NextResponse.json(
      { imageCid, imageURI },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[0xFi/ipfs/upload] Pinata upload failed:", error);
    return jsonError("IPFS upload failed. Please retry.", 502);
  } finally {
    inFlightSignatures.delete(signatureKey);
  }
}

/**
 * Verify that `wallet` is the owner of the token at `tokenAddress`. Tries the
 * standard Ownable `owner()` view first; if the contract does not expose it or
 * the returned owner does not match, falls back to checking that the wallet
 * holds the entire token supply (covers simple deploy-and-mint-all tokens).
 */
async function checkTokenOwner(tokenAddress: Address, wallet: Address): Promise<boolean> {
  try {
    const owner = (await client.readContract({
      address: tokenAddress,
      abi: ownableAbi,
      functionName: "owner",
    })) as Address;
    if (owner && owner.toLowerCase() === wallet.toLowerCase()) return true;
  } catch {
    // Token does not implement Ownable or the call reverted. Fall through.
  }

  // Fallback: wallet must hold the entire supply and supply must be nonzero.
  try {
    const balance = (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    const supply = (await client.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "totalSupply",
    })) as bigint;
    return supply > 0n && balance === supply;
  } catch {
    return false;
  }
}

function validateImage(file: File): string | null {
  const mimeType = file.type.trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
    return "Only PNG, JPEG, and WebP logos are accepted";
  }
  if (file.size < MIN_IMAGE_BYTES || file.size > MAX_IMAGE_BYTES) {
    return "Logo must be between 100 bytes and 2 MB";
  }
  return null;
}

function normalizeUploadMessage(message: string): string {
  return message.replace(/\r\n?/g, "\n");
}

function parseUploadMessage(message: string): FiUploadMessageFields | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const address = typeof obj.address === "string" ? obj.address : "";
  const tokenAddress = typeof obj.tokenAddress === "string" ? obj.tokenAddress : "";
  const domain = typeof obj.domain === "string" ? obj.domain : "";
  const chainId = typeof obj.chainId === "number" ? obj.chainId : Number(obj.chainId);
  const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(tokenAddress)) return null;
  if (!domain || domain.length > 255) return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) return null;

  return {
    address: address as Address,
    tokenAddress: tokenAddress as Address,
    domain,
    chainId,
    timestamp,
  };
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
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new UploadBodyTooLargeError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
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
  const configuredHeader = process.env.UPLOAD_TRUSTED_PROXY_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (configuredHeader && /^[a-z0-9-]{1,64}$/.test(configuredHeader)) {
    const value = request.headers.get(configuredHeader);
    const address = configuredHeader.includes("forwarded")
      ? rightmostForwardedIp(value)
      : normalizedIp(value);
    if (address) return `${configuredHeader}:${address}`;
  }

  if (process.env.VERCEL === "1") {
    const address = rightmostForwardedIp(request.headers.get("x-vercel-forwarded-for"))
      ?? rightmostForwardedIp(request.headers.get("x-forwarded-for"))
      ?? normalizedIp(request.headers.get("x-real-ip"));
    if (address) return `vercel:${address}`;
  }

  return "unidentified-client";
}

function normalizedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  let candidate = value.trim().replace(/^"|"$/g, "");
  if (!candidate) return undefined;

  if (candidate.startsWith("[")) {
    const closingBracket = candidate.indexOf("]");
    if (closingBracket > 1) candidate = candidate.slice(1, closingBracket);
  } else if (isIP(candidate) === 0) {
    const separator = candidate.lastIndexOf(":");
    if (separator > 0 && /^\d+$/.test(candidate.slice(separator + 1))) {
      const withoutPort = candidate.slice(0, separator);
      if (isIP(withoutPort) !== 0) candidate = withoutPort;
    }
  }

  return isIP(candidate) !== 0 ? candidate.toLowerCase() : undefined;
}

function rightmostForwardedIp(value: string | null): string | undefined {
  if (!value) return undefined;
  const entries = value.split(",");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = normalizedIp(entries[index]);
    if (candidate) return candidate;
  }
  return undefined;
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

function consumeRateLimit(key: string, now: number): boolean {
  const recent = (requestHistory.get(key) ?? []).filter(
    (timestamp) => timestamp > now - RATE_WINDOW_MS,
  );
  if (recent.length >= RATE_MAX_ATTEMPTS) {
    requestHistory.set(key, recent);
    return false;
  }
  if (!requestHistory.has(key) && requestHistory.size >= MAX_RATE_LIMIT_KEYS) {
    const oldestKey = requestHistory.keys().next().value as string | undefined;
    if (oldestKey) requestHistory.delete(oldestKey);
  }
  recent.push(now);
  requestHistory.set(key, recent);
  return true;
}

function pruneTransientState(now: number) {
  for (const [key, timestamps] of requestHistory) {
    const recent = timestamps.filter((timestamp) => timestamp > now - RATE_WINDOW_MS);
    if (recent.length) requestHistory.set(key, recent);
    else requestHistory.delete(key);
  }
  for (const [signature, timestamp] of consumedSignatures) {
    if (timestamp <= now - SIGNATURE_TTL_MS) consumedSignatures.delete(signature);
  }
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
  const extension = original.toLowerCase().match(/\.(png|jpe?g|webp)$/)?.[0] ?? "";
  return `${fallback.replace(/[^a-zA-Z0-9_-]/g, "-")}${extension}`;
}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
