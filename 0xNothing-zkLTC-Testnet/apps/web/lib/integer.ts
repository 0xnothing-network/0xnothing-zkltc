/** Parse an integer-like value without allowing negative or fractional data. */
export function nonNegativeBigInt(
  value: string | number | bigint | undefined,
): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && !/^\d+$/.test(value)) return undefined;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return undefined;
  try {
    const parsed = BigInt(value);
    return parsed >= 0n ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function hasPositiveBigInt(
  ...values: Array<string | number | bigint | undefined>
): boolean {
  return values.some((value) => (nonNegativeBigInt(value) ?? 0n) > 0n);
}
