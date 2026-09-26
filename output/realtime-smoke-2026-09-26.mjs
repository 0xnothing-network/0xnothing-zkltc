import { writeFile } from "node:fs/promises";

const base = "http://127.0.0.1:3317";
const rows = [];
for (const path of ["/", "/0xFi/swap", "/0xPump", "/0xpixel/marketplace", "/0xFi/api/data/pools", "/api/pump/stats", "/api/marketplace/listings"]) {
  const samples = path.includes("/api/") ? 2 : 1;
  for (let sample = 0; sample < samples; sample += 1) {
    const start = performance.now();
    try {
      const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(25_000) });
      const body = await response.text();
      let data;
      try { data = JSON.parse(body); } catch { /* HTML route. */ }
      const row = {
        path, sample, status: response.status, elapsedMs: Math.round(performance.now() - start),
        bytes: Buffer.byteLength(body), cache: response.headers.get("x-cache"),
        warning: data?.warning, error: data?.error,
        records: data?.data?.length ?? data?.listings?.length,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (error) {
      const row = { path, sample, elapsedMs: Math.round(performance.now() - start), error: String(error) };
      rows.push(row);
      console.log(JSON.stringify(row));
    }
  }
}
await writeFile(new URL("./realtime-smoke-2026-09-26.json", import.meta.url), JSON.stringify({ base, at: new Date().toISOString(), rows }, null, 2));
