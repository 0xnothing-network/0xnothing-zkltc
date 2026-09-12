import { normalizePumpIpfsPath } from "@/features/pump/config";
import { createBoundedCache } from "@/lib/boundedCache";
import { readLimitedBytes } from "@/lib/server/readLimitedBytes";

export const runtime = "nodejs";
const MAX_BYTES = 64 * 1024;
const cache = createBoundedCache<Record<string, unknown> | null>({ maxEntries: 256, ttlMs: 3_600_000, maxInFlight: 32 });

async function loadMetadata(cid: string): Promise<Record<string, unknown> | null> {
  const [root, ...path] = cid.split("/");
  const dweb = root.startsWith("b") ? `https://${root}.ipfs.dweb.link/${path.join("/")}` : `https://dweb.link/ipfs/${cid}`;
  const urls = [`https://gateway.pinata.cloud/ipfs/${cid}`, dweb];
  const controllers = urls.map(() => new AbortController());
  const timer = setTimeout(() => controllers.forEach((controller) => controller.abort()), 8_000);
  try {
    return await Promise.any(urls.map(async (url, index) => {
      // Fixed gateways only. Reject redirects rather than proxy arbitrary destinations.
      const response = await fetch(url, { redirect: "error", cache: "no-store", signal: controllers[index].signal, headers: { Accept: "application/json" } });
      if (!response.ok || !response.body) throw new Error("Metadata unavailable");
      if (Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body.cancel();
        throw new Error("Metadata too large");
      }
      const bytes = await readLimitedBytes(response.body, MAX_BYTES, () => new Error("Metadata too large"));
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid metadata");
      const metadata = value as Record<string, unknown>;
      const properties = metadata.properties && typeof metadata.properties === "object" ? metadata.properties as Record<string, unknown> : {};
      const text = (value: unknown) => typeof value === "string" ? value.slice(0, 2048) : undefined;
      return { description: text(metadata.description), external_url: text(metadata.external_url), properties: { website: text(properties.website), twitter: text(properties.twitter) } };
    }));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controllers.forEach((controller) => controller.abort());
  }
}

export async function GET(request: Request) {
  const cid = normalizePumpIpfsPath(new URL(request.url).searchParams.get("cid") ?? "");
  if (!cid) return Response.json({ error: "Invalid IPFS CID" }, { status: 400 });
  if (cache.saturated() && cache.get(cid) === undefined && !cache.pending(cid)) {
    return Response.json({ error: "Metadata service busy" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const metadata = await cache.load(cid, () => loadMetadata(cid), (value) => value ? 3_600_000 : 30_000);
  return Response.json(metadata ?? {}, { headers: { "Cache-Control": metadata ? "public, max-age=3600" : "public, max-age=30", "X-Pump-Metadata-Status": metadata ? "available" : "unavailable" } });
}
