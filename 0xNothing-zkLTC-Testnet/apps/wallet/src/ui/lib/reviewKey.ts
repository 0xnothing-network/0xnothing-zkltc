export type ReviewKeyPart = string | number | boolean | bigint | null | undefined;

/**
 * Identity for the mutable values behind a transaction review. Type tags keep
 * values such as the string `"1"` distinct from the number or bigint `1`.
 */
export function reviewKey(parts: readonly ReviewKeyPart[]): string {
  return JSON.stringify(parts.map((part) => {
    if (part === null) return ["null", ""];
    if (part === undefined) return ["undefined", ""];
    return [typeof part, String(part)];
  }));
}
