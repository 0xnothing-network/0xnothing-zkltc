import { readLimitedBytes } from "./readLimitedBytes.ts";

export class ResponseBodyTooLargeError extends Error {}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/**
 * Parse an upstream JSON response without allowing a compressed or chunked body
 * to grow without bound in server memory.
 */
export async function readLimitedJson<T>(
  response: Response,
  maxBytes: number,
): Promise<T> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("JSON byte limit must be a non-negative safe integer");
  }

  const declaredLength = response.headers.get("content-length")?.trim();
  if (declaredLength && /^\d+$/.test(declaredLength)) {
    if (BigInt(declaredLength) > BigInt(maxBytes)) {
      await cancelResponseBody(response);
      throw new ResponseBodyTooLargeError("Upstream JSON response exceeds size limit");
    }
  }

  if (!response.body) throw new SyntaxError("Upstream JSON response has no body");
  const bytes = await readLimitedBytes(
    response.body,
    maxBytes,
    () => new ResponseBodyTooLargeError("Upstream JSON response exceeds size limit"),
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as T;
}
