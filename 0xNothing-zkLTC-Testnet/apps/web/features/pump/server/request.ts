import "server-only";

export function boundedIntegerParam(
  params: URLSearchParams,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) return undefined;

  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return Math.min(Math.max(value, minimum), maximum);
}
