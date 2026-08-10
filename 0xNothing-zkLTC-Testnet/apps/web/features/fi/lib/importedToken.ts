import type { Address } from "viem";

export type ImportedTokenMetadataSource = "explorer" | "onchain";

export type ImportedTokenExplorerStatus =
  | "verified"
  | "not-indexed"
  | "unavailable"
  | "invalid";

export interface ImportedTokenMetadata {
  address: Address;
  decimals: number;
  explorerStatus: ImportedTokenExplorerStatus;
  metadataSource: ImportedTokenMetadataSource;
  name: string;
  symbol: string;
  totalSupply: string;
}

export interface ImportedTokenSuccessResponse {
  data: ImportedTokenMetadata;
  status: "ready";
}

export interface ImportedTokenErrorResponse {
  error: string;
  explorerStatus?: ImportedTokenExplorerStatus;
  status: "invalid" | "unsupported" | "unavailable";
}

export type ImportedTokenApiResponse = ImportedTokenSuccessResponse | ImportedTokenErrorResponse;
