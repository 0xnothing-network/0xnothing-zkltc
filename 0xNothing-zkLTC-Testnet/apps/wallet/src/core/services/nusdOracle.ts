import type { Address } from "viem";
import { nusdOracleAbi } from "../../abis";
import { CONTRACTS } from "../../config/contracts";
import { activeNetwork, publicClient } from "../rpc/client";
import type { WalletNetwork } from "../../config/networks";

/**
 * Which oracle a zkLTC price should come from.
 *
 * NUSD holds its LTC/USD oracle router in an `immutable` and prices every mint
 * and redeem through it, so that contract is the one whose number the wallet
 * shows: a price the mint does not use is a price the user cannot act on. The
 * router's DIA source can be replaced, but the router address itself never
 * changes.
 *
 * The address cannot change on a given chain, so it is read once per selected
 * RPC profile and kept for the life of that profile. The configured address is
 * the fallback for a failed read.
 */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const FAILURE_TTL_MS = 5_000;

const cachedByNetwork = new Map<string, Address>();
const pendingByNetwork = new Map<string, Promise<Address>>();
const fallbackUntilByNetwork = new Map<string, number>();

export function nusdOracleAddress(
  network: WalletNetwork = activeNetwork,
  client: typeof publicClient = publicClient,
): Promise<Address> {
  const key = `${network.id}:${network.rpcUrl}`;
  const cached = cachedByNetwork.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = pendingByNetwork.get(key);
  if (pending !== undefined) return pending;
  if (Date.now() < (fallbackUntilByNetwork.get(key) ?? 0)) {
    return Promise.resolve(CONTRACTS.nusdOracleAdapter);
  }

  const request = client
    .readContract({
      address: CONTRACTS.nusd,
      abi: nusdOracleAbi,
      functionName: "oracle",
    })
    .then((onChain) => {
      const resolved = onChain === ZERO_ADDRESS ? CONTRACTS.nusdOracleAdapter : onChain;
      cachedByNetwork.set(key, resolved);
      fallbackUntilByNetwork.delete(key);
      return resolved;
    })
    .catch(() => {
      // A transient RPC failure must not permanently pin the configured
      // fallback, but concurrent callers and a busy endpoint should get a
      // short quiet window before the next immutable lookup.
      fallbackUntilByNetwork.set(key, Date.now() + FAILURE_TTL_MS);
      return CONTRACTS.nusdOracleAdapter;
    });
  pendingByNetwork.set(key, request);
  void request.then(() => {
    if (pendingByNetwork.get(key) === request) pendingByNetwork.delete(key);
  });
  return request;
}
