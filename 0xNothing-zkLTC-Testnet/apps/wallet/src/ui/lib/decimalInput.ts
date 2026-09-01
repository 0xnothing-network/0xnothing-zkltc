/**
 * Normalizes a user-entered token amount without ever deleting characters that
 * could join two separate digit groups. Silently turning `1e3` into `13`, for
 * example, is much more dangerous than leaving it invalid for `parseAmount` to
 * reject. A single decimal comma is accepted for locale keyboards.
 */
export function normalizeDecimalInput(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  if (!/^\d*(?:[.,]\d*)?$/u.test(trimmed)) return trimmed;
  const normalized = trimmed.replace(",", ".");
  return normalized.startsWith(".") ? `0${normalized}` : normalized;
}
