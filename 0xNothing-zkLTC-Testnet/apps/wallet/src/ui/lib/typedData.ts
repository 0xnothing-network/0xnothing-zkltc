import { hexToBytes, isHex, stringToHex } from "viem";

export interface TypedDataSummary {
  domain: string;
  primaryType: string;
  chainId: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A dapp supplies arbitrary JSON: nothing reaches React before its shape is checked. */
export function typedSummary(message: string): TypedDataSummary | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (!isRecord(parsed)) return null;
    const domain = parsed.domain;
    if (domain !== undefined && !isRecord(domain)) return null;
    const name = domain?.name;
    const primaryType = parsed.primaryType;
    if (name !== undefined && typeof name !== "string") return null;
    if (primaryType !== undefined && typeof primaryType !== "string") return null;

    const rawChainId = domain?.chainId;
    let chainId: number | null = null;
    if (rawChainId !== undefined) {
      if (
        typeof rawChainId !== "number"
        && !(typeof rawChainId === "string" && /^(?:\d+|0x[0-9a-f]+)$/iu.test(rawChainId))
      ) return null;
      chainId = Number(rawChainId);
      if (!Number.isSafeInteger(chainId) || chainId < 0) return null;
    }
    return { domain: name ?? "—", primaryType: primaryType ?? "—", chainId };
  } catch {
    return null;
  }
}

// Visible text only: bidi overrides, zero-width and other format or control
// characters could reorder or hide part of what the user is asked to sign.
const SHOWN_AS_TEXT = /^[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]*$/u;

const SHOWN_AS_CHAR = /[\p{L}\p{M}\p{N}\p{P}\p{S}\p{Zs}\n\r\t]/u;

/**
 * Typed data as it will be signed, not as the page wrote it. Re-serialising the
 * parsed value collapses a duplicated key to the one JSON.parse (and so the
 * signer) keeps and drops padding; any invisible or reordering character is
 * shown as its \uXXXX escape instead of being rendered.
 */
export function readableTypedData(message: string): string {
  let text = message;
  try {
    text = JSON.stringify(JSON.parse(message), null, 2);
  } catch {
    // Unparseable data is already refused for signing; show it verbatim, escaped.
  }
  return Array.from(text, (char) => SHOWN_AS_CHAR.test(char)
    ? char
    : `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`).join("");
}

/** personal_sign carries hex-encoded UTF-8 far more often than plain text. */
export function readableSignMessage(message: string): string {
  if (!isHex(message)) return SHOWN_AS_TEXT.test(message) ? message : stringToHex(message);
  try {
    // Fatal decoding: bytes that are not UTF-8 stay hex instead of becoming U+FFFD.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(message));
    return SHOWN_AS_TEXT.test(text) ? text : message;
  } catch {
    return message;
  }
}
