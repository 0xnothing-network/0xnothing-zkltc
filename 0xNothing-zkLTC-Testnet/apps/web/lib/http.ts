function responseError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as { error?: unknown }).error;
  if (typeof value !== "string") return undefined;
  const message = value.trim();
  return message ? message.slice(0, 240) : undefined;
}

export async function fetchJson<T>(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  fallbackMessage = "Request failed",
): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => undefined) as unknown;

  if (!response.ok) {
    throw new Error(responseError(payload) ?? `${fallbackMessage} (HTTP ${response.status})`);
  }
  if (payload === undefined) {
    throw new Error(`${fallbackMessage}: invalid JSON response`);
  }
  return payload as T;
}
