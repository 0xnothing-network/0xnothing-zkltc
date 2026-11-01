/**
 * A lone decimal comma reads as a dot: iOS decimal keypads in vi, de or fr offer no
 * ".". A comma followed by exactly three digits stays invalid, because "1,000" is as
 * likely an English thousand as one, and guessing wrong moves 1000x the amount.
 */
export function decimalInput(value: string): string {
  const trimmed = value.trim();
  return /^\d*,\d*$/.test(trimmed) && !/^[1-9]\d{0,2},\d{3}$/.test(trimmed)
    ? trimmed.replace(",", ".")
    : trimmed;
}
