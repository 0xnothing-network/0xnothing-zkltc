/**
 * Asks one RPC endpoint for its chain id, once, before the wallet trusts it with
 * a network profile. Deliberately not viem: no batching, no retries, no fallback
 * to another endpoint, so the answer shown is this URL's own. A redirect is
 * refused (the URL reviewed must be the URL that answers), the body is read up to
 * a small cap, and nothing throws: any failure is `null`.
 */
const MAX_PROBE_BYTES = 64 * 1024;
const CHAIN_ID_RESULT = /^0x[0-9a-fA-F]{1,16}$/u;
const PROBE_BODY = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}';

async function boundedText(response: Response, controller: AbortController): Promise<string | null> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_PROBE_BYTES) {
      controller.abort();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function probeChainId(
  rpcUrl: string,
  timeoutMs = 8_000,
  fetcher: typeof fetch = fetch,
): Promise<bigint | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: PROBE_BODY,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok || response.redirected) return null;
    const text = await boundedText(response, controller);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    const result = parsed !== null && typeof parsed === "object" ? (parsed as { result?: unknown }).result : undefined;
    return typeof result === "string" && CHAIN_ID_RESULT.test(result) ? BigInt(result) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
