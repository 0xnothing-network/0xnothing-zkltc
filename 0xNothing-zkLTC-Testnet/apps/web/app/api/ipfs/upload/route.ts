import { NextResponse } from "next/server";
import { verifyMessage, type Address, type Hex } from "viem";
import { zeroXPumpAbi } from "@/features/pump/abis";
import { computePumpContentHash } from "@/features/pump/contentHash";
import { validatePumpImage } from "@/features/pump/imageValidation";
import {
  PUMP_CHAIN_ID,
  PUMP_CONFIGURED,
  PUMP_FACTORY_ADDRESS,
} from "@/features/pump/config";
import {
  normalizePumpUploadMessage,
  parsePumpUploadMessage,
} from "@/features/pump/uploadMessage";
import { publicClient } from "@/lib/contract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SIGNATURE_TTL_MS = 5 * 60_000;
const FUTURE_CLOCK_SKEW_MS = 30_000;
const RATE_WINDOW_MS = 10 * 60_000;
const RATE_MAX_ATTEMPTS = 5;

const requestHistory = new Map<string, number[]>();
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

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
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
  if (!validOptionalUrl(website)) return jsonError("Invalid website URL", 400);
  if (!validOptionalUrl(twitter)) return jsonError("Invalid social URL", 400);

  const fields = parsePumpUploadMessage(message);
  if (!fields || fields.address.toLowerCase() !== submittedAddress) {
    return jsonError("Signed upload message does not match the wallet", 401);
  }
  if (fields.contentHash.toLowerCase() !== submittedContentHash) {
    return jsonError("Signed upload message does not match the content hash", 401);
  }

  const expectedDomain = uploadDomain(request);
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

function uploadDomain(request: Request): string {
  const configured = process.env.UPLOAD_SIGNING_DOMAIN?.trim();
  if (configured) return configured.toLowerCase();
  const host = request.headers.get("host")?.trim();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = host || forwardedHost;
  return (requestHost || new URL(request.url).host).toLowerCase();
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

function consumeRateLimit(key: string, now: number): boolean {
  const recent = (requestHistory.get(key) ?? []).filter(
    (timestamp) => timestamp > now - RATE_WINDOW_MS,
  );
  if (recent.length >= RATE_MAX_ATTEMPTS) {
    requestHistory.set(key, recent);
    return false;
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

function validOptionalUrl(value: string): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && value.length <= 256;
  } catch {
    return false;
  }
}

function jsonError(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
