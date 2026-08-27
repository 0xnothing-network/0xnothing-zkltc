/**
 * Drain a byte stream into one bounded buffer. The reader is cancelled on
 * overflow or stream failure so upstream connections are not left hanging.
 */
export async function readLimitedBytes(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  createTooLargeError: () => Error,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new RangeError("Byte limit must be a non-negative safe integer");
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw createTooLargeError();
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
  return output;
}
