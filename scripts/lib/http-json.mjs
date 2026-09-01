const DEFAULT_MAX_BYTES = 1024 * 1024;

function checkedLimit(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("HTTP JSON response limit must be a positive safe integer");
  }
  return maxBytes;
}

export async function readLimitedJsonResponse(response, {
  label = "HTTP endpoint",
  maxBytes = DEFAULT_MAX_BYTES,
} = {}) {
  const limit = checkedLimit(maxBytes);
  const contentLength = response.headers?.get?.("content-length");
  if (/^\d+$/u.test(contentLength || "") && Number(contentLength) > limit) {
    throw new Error(`${label} response exceeds ${limit} bytes`);
  }

  let text = "";
  let bytesRead = 0;
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesRead += value.byteLength;
        if (bytesRead > limit) {
          await reader.cancel();
          throw new Error(`${label} response exceeds ${limit} bytes`);
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    bytesRead = Buffer.byteLength(text, "utf8");
    if (bytesRead > limit) throw new Error(`${label} response exceeds ${limit} bytes`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}
