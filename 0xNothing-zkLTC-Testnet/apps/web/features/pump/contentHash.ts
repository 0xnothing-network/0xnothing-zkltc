import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";

export const PUMP_CONTENT_DOMAIN_TAG = "0xPump Market Content";
export const PUMP_CONTENT_VERSION = 1n;

const CONTENT_HASH_PARAMETERS = parseAbiParameters(
  "string,uint256,uint256,address,address,string,string,string,string,string,string,uint256,bytes32",
);

export interface PumpContentInput {
  chainId: number;
  factory: Address;
  owner: Address;
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  file: Blob;
}

export interface CanonicalPumpContent {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  mimeType: string;
}

export function canonicalPumpContent(input: PumpContentInput): CanonicalPumpContent {
  return {
    name: normalizeText(input.name).trim(),
    symbol: normalizeText(input.symbol).trim().toUpperCase(),
    description: normalizeText(input.description).trim(),
    website: normalizeText(input.website).trim(),
    twitter: normalizeText(input.twitter).trim(),
    mimeType: input.file.type.trim().toLowerCase(),
  };
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

export async function computePumpContentHash(input: PumpContentInput): Promise<Hex> {
  const canonical = canonicalPumpContent(input);
  const fileBytes = new Uint8Array(await input.file.arrayBuffer());
  const fileHash = keccak256(fileBytes);
  return keccak256(
    encodeAbiParameters(CONTENT_HASH_PARAMETERS, [
      PUMP_CONTENT_DOMAIN_TAG,
      PUMP_CONTENT_VERSION,
      BigInt(input.chainId),
      input.factory,
      input.owner,
      canonical.name,
      canonical.symbol,
      canonical.description,
      canonical.website,
      canonical.twitter,
      canonical.mimeType,
      BigInt(fileBytes.byteLength),
      fileHash,
    ]),
  );
}
