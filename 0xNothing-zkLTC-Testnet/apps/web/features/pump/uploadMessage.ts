import type { Address, Hex } from "viem";

export const PUMP_UPLOAD_STATEMENT = "0xPump token logo upload";

export interface UploadMessageFields {
  address: Address;
  chainId: number;
  domain: string;
  contentHash: Hex;
  nonce: string;
  timestamp: string;
}

export function normalizePumpUploadMessage(message: string): string {
  return message.replace(/\r\n?/g, "\n");
}

export function buildPumpUploadMessage(fields: UploadMessageFields): string {
  return [
    PUMP_UPLOAD_STATEMENT,
    `Domain: ${fields.domain}`,
    `Address: ${fields.address.toLowerCase()}`,
    `Chain ID: ${fields.chainId}`,
    `Content Hash: ${fields.contentHash.toLowerCase()}`,
    `Timestamp: ${fields.timestamp}`,
    `Nonce: ${fields.nonce}`,
  ].join("\n");
}

export function parsePumpUploadMessage(message: string): UploadMessageFields | null {
  const lines = normalizePumpUploadMessage(message).split("\n");
  if (lines.length !== 7 || lines[0] !== PUMP_UPLOAD_STATEMENT) return null;

  const domain = lines[1].replace(/^Domain: /, "").trim();
  const address = lines[2].replace(/^Address: /, "").trim();
  const chainId = Number(lines[3].replace(/^Chain ID: /, "").trim());
  const contentHash = lines[4].replace(/^Content Hash: /, "").trim();
  const timestamp = lines[5].replace(/^Timestamp: /, "").trim();
  const nonce = lines[6].replace(/^Nonce: /, "").trim();

  if (!domain || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(contentHash)) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp)) return null;
  if (!/^[a-zA-Z0-9_-]{16,96}$/.test(nonce)) return null;

  return {
    address: address as Address,
    chainId,
    domain,
    contentHash: contentHash as Hex,
    nonce,
    timestamp,
  };
}
