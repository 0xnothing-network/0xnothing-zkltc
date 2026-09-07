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
