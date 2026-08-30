import { type Address, erc20Abi as viemErc20Abi, type Hex, isAddress } from "viem";
import type { WalletToken } from "../../config/assets";
import { formatAmount } from "../lib/format";
import { publicClient } from "../rpc/client";
import { sendNative, writeCall } from "./tx";

/**
 * Sending. Native zkLTC goes out as a plain value transfer; ERC-20s as
 * transfer(). The gas estimate is quoted before signing so the user can see
 * whether the remaining zkLTC still covers the fee.
 */
export interface SendQuote {
  gas: bigint;
  maxFeePerGas: bigint;
  feeWei: bigint;
}

export function validateRecipient(value: string): Address | null {
  const trimmed = value.trim();
  return isAddress(trimmed) ? (trimmed as Address) : null;
}

export async function quoteSend(params: {
  from: Address;
  to: Address;
  token: WalletToken;
  amount: bigint;
}): Promise<SendQuote> {
  const fees = await publicClient.estimateFeesPerGas().catch(async () => ({
    maxFeePerGas: await publicClient.getGasPrice(),
    maxPriorityFeePerGas: 0n,
  }));
  const maxFeePerGas = fees.maxFeePerGas ?? 0n;

  const gas = params.token.address
    ? await publicClient.estimateContractGas({
        account: params.from,
        address: params.token.address,
        abi: viemErc20Abi,
        functionName: "transfer",
        args: [params.to, params.amount],
      })
    : await publicClient.estimateGas({
        account: params.from,
        to: params.to,
        value: params.amount,
      });

  // A 20% headroom on the estimate: the same call can cost more once other
  // transactions in the block have touched the same storage.
  const padded = (gas * 12n) / 10n;
  return { gas: padded, maxFeePerGas, feeWei: padded * maxFeePerGas };
}

export async function sendToken(params: {
  from: Address;
  to: Address;
  token: WalletToken;
  amount: bigint;
}): Promise<Hex> {
  const pretty = `${formatAmount(params.amount, params.token.decimals)} ${params.token.symbol}`;
  const label = { key: "tx.send", params: { amount: pretty } } as const;
  if (!params.token.address) {
    return sendNative({
      from: params.from,
      to: params.to,
      value: params.amount,
      label,
    });
  }
  return writeCall({
    from: params.from,
    address: params.token.address,
    abi: viemErc20Abi,
    functionName: "transfer",
    args: [params.to, params.amount],
    kind: "send",
    label,
    detail: params.to,
  });
}
