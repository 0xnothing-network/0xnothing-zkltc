import type { Address } from "viem";
import type { WalletNetwork } from "./networks";
import { CONTRACTS } from "./contracts";

/**
 * How a token's USD price is obtained. There is no price API in this wallet;
 * everything comes from the same on-chain sources the web app uses.
 *
 *  - "oracle": DIA LTC/USD feed via the NUSD oracle adapter (zkLTC, WzkLTC)
 *  - "usd":    hard $1 (NUSD is the unit of account of the whole system)
 *  - "pool":   spot from the token's 0xPump curve or NUSD pair reserves
 *  - "none":   not priced; balance still shown, USD shown as "--"
 */
export type PriceSource = "oracle" | "usd" | "pool" | "none";

export interface WalletToken {
  /** Stable list/storage key. "native" for the gas coin. */
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Undefined for the native coin. */
  address?: Address;
  priceSource: PriceSource;
  logo?: string;
  /** Built-ins cannot be removed by the user. */
  builtin: boolean;
  /** Canonical LitVM assets that may display the wallet's verified CORE mark. */
  verified?: boolean;
  /** Built-ins that stay listed even at a zero balance. */
  pinned?: boolean;
}

export const NATIVE_TOKEN: WalletToken = {
  id: "native",
  symbol: "zkLTC",
  name: "LitVM LiteForge",
  decimals: 18,
  priceSource: "oracle",
  logo: "tokens/ltc-logo.png",
  builtin: true,
  verified: true,
  pinned: true,
};

/** Native metadata follows the selected custom network; LitVM keeps its copy. */
export function nativeTokenFor(network: WalletNetwork): WalletToken {
  if (network.builtin) return NATIVE_TOKEN;
  return {
    ...NATIVE_TOKEN,
    symbol: network.nativeCurrency.symbol,
    name: network.nativeCurrency.name,
    decimals: network.nativeCurrency.decimals,
    priceSource: "none",
    logo: undefined,
    verified: false,
  };
}

export const NUSD_TOKEN: WalletToken = {
  id: CONTRACTS.nusd.toLowerCase(),
  symbol: "NUSD",
  name: "Nothing USD",
  decimals: 18,
  address: CONTRACTS.nusd,
  priceSource: "usd",
  logo: "tokens/NUSD_LOGO.jpg",
  builtin: true,
  verified: true,
  pinned: true,
};

/**
 * Listed only once a balance exists — a wallet that shows three permanent zeros
 * reads as broken. Pinned entries above are the exception.
 */
export const BUILTIN_TOKENS: readonly WalletToken[] = [
  NATIVE_TOKEN,
  NUSD_TOKEN,
  {
    id: CONTRACTS.wzkltc.toLowerCase(),
    symbol: "WzkLTC",
    name: "Wrapped zkLTC",
    decimals: 18,
    address: CONTRACTS.wzkltc,
    priceSource: "oracle",
    logo: "tokens/ltc-logo.png",
    builtin: true,
  },
  {
    id: CONTRACTS.nbtc.toLowerCase(),
    symbol: "nBTC",
    name: "Nothing BTC",
    decimals: 18,
    address: CONTRACTS.nbtc,
    priceSource: "pool",
    logo: "tokens/btc-logo.png",
    builtin: true,
  },
  {
    id: CONTRACTS.neth.toLowerCase(),
    symbol: "nETH",
    name: "Nothing ETH",
    decimals: 18,
    address: CONTRACTS.neth,
    priceSource: "pool",
    logo: "tokens/eth-logo.webp",
    builtin: true,
  },
];

export const FALLBACK_TOKEN_LOGO = "tokens/0xNothing.jpg";

/** Tokens the user imported by address (0xPump launches, LP tokens, …). */
export function customToken(input: {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logo?: string;
}): WalletToken {
  return {
    id: input.address.toLowerCase(),
    symbol: input.symbol,
    name: input.name,
    decimals: input.decimals,
    address: input.address,
    priceSource: "pool",
    logo: input.logo,
    builtin: false,
  };
}
