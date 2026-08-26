"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Abi, Address, Hash } from "viem";
import {
  useAccount,
  usePublicClient,
  useSwitchChain,
  useWalletClient,
} from "wagmi";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { deployment } from "@fi/config/deployment";
import { readableError } from "@fi/lib/errors";
import { isBlockSyncedQueryKey } from "@/lib/liveData";

export type TransactionPhase =
  | "idle"
  | "switching"
  | "approving"
  | "simulating"
  | "confirming"
  | "success"
  | "error";

export interface ProtocolCall {
  address?: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

export interface TokenApproval {
  token?: Address;
  spender?: Address;
  /** Omit to approve exactly what the previous stage delivered. */
  amount?: bigint;
}

/**
 * One wallet-confirmed stage. `deliveredToken` measures the wallet balance delta
 * the stage produced, and the next stage is built from that exact amount, so a
 * route that can only settle in two transactions always spends what really
 * landed rather than what was quoted a block earlier.
 */
export interface ProtocolStage {
  approval?: TokenApproval | readonly TokenApproval[];
  call: ProtocolCall | ((deliveredAmount: bigint) => ProtocolCall);
  deliveredToken?: Address;
}

type ExecuteOptions =
  | { call: ProtocolCall; approval?: TokenApproval | readonly TokenApproval[]; stages?: undefined }
  | { stages: readonly ProtocolStage[]; call?: undefined; approval?: undefined };

interface TransactionState {
  phase: TransactionPhase;
  message: string;
  hash?: Hash;
}

const INITIAL_STATE: TransactionState = { phase: "idle", message: "" };

function approvalList(
  approval: TokenApproval | readonly TokenApproval[] | undefined,
): readonly TokenApproval[] {
  if (!approval) return [];
  return Array.isArray(approval) ? approval : [approval as TokenApproval];
}

export function useProtocolTransaction() {
  const queryClient = useQueryClient();
  const { address, chainId, isConnected } = useAccount();
  const publicClient = usePublicClient({ chainId: deployment.chain.id });
  const {
    data: walletClient,
    refetch: refetchWalletClient,
  } = useWalletClient({ chainId: deployment.chain.id });
  const { switchChainAsync } = useSwitchChain();
  const [state, setState] = useState<TransactionState>(INITIAL_STATE);
  const inFlightRef = useRef(false);

  const reset = useCallback(() => {
    if (!inFlightRef.current) setState(INITIAL_STATE);
  }, []);

  const execute = useCallback(
    async (options: ExecuteOptions): Promise<Hash | undefined> => {
      if (inFlightRef.current) return undefined;
      if (options.call && !options.call.address) {
        setState({ phase: "error", message: "Not deployed. This transaction is disabled." });
        return undefined;
      }
      if (!isConnected || !address) {
        setState({ phase: "error", message: "Connect a wallet before submitting a transaction." });
        return undefined;
      }
      if (!publicClient) {
        setState({ phase: "error", message: "LitVM RPC is unavailable. Try again shortly." });
        return undefined;
      }

      const stages: readonly ProtocolStage[] = options.stages
        ?? [{ approval: options.approval, call: options.call }];
      const totalSteps = stages.reduce(
        (total, stage) => total + 1 + approvalList(stage.approval).length,
        0,
      );
      const readBalance = (token: Address) => publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });

      inFlightRef.current = true;
      setState({ phase: "simulating", message: "Preparing latest on-chain state" });
      try {
        let wallet = walletClient;
        if (chainId !== deployment.chain.id) {
          setState({ phase: "switching", message: "Switching to LitVM LiteForge" });
          await switchChainAsync({ chainId: deployment.chain.id });
          wallet = (await refetchWalletClient()).data;
        } else if (!wallet) {
          wallet = (await refetchWalletClient()).data;
        }

        if (!wallet) throw new Error("Wallet client is not ready");

        let step = 0;
        let delivered = 0n;
        let lastHash: Hash | undefined;
        for (const stage of stages) {
          for (const item of approvalList(stage.approval)) {
            step += 1;
            const amount = item.amount ?? delivered;
            if (!item.token || !item.spender || amount <= 0n) continue;
            const allowance = await publicClient.readContract({
              address: item.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, item.spender],
            });

            if (allowance < amount) {
              setState({ phase: "approving", message: `Step ${step}/${totalSteps} · Approve token` });
              const approvalSimulation = await publicClient.simulateContract({
                account: address,
                address: item.token,
                abi: erc20Abi,
                functionName: "approve",
                args: [item.spender, amount],
              });
              const approvalHash = await wallet.writeContract(approvalSimulation.request);
              const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
              if (approvalReceipt.status !== "success") throw new Error("Token approval reverted");
            }
          }

          const call = typeof stage.call === "function" ? stage.call(delivered) : stage.call;
          if (!call.address) throw new Error("Not deployed. This transaction is disabled.");
          setState({ phase: "simulating", message: "Checking latest on-chain state" });
          const balanceBefore = stage.deliveredToken ? await readBalance(stage.deliveredToken) : 0n;
          const simulation = await publicClient.simulateContract({
            account: address,
            address: call.address,
            abi: call.abi,
            functionName: call.functionName,
            args: call.args,
            value: call.value,
          });

          step += 1;
          setState({ phase: "confirming", message: `Step ${step}/${totalSteps} · Confirm transaction` });
          const hash = await wallet.writeContract(simulation.request);
          setState({ phase: "confirming", message: "Submitted · Confirming on-chain", hash });
          const receipt = await publicClient.waitForTransactionReceipt({ hash });
          if (receipt.status !== "success") throw new Error("Transaction reverted");
          lastHash = hash;
          if (stage.deliveredToken) {
            delivered = (await readBalance(stage.deliveredToken)) - balanceBefore;
          }
        }

        void queryClient.invalidateQueries({
          predicate: (query) => isBlockSyncedQueryKey(query.queryKey),
        });
        setState({ phase: "success", message: "Confirmed on LitVM", hash: lastHash });
        return lastHash;

      } catch (error) {
        setState({ phase: "error", message: readableError(error) });
        return undefined;
      } finally {
        inFlightRef.current = false;
      }
    },
    [address, chainId, isConnected, publicClient, queryClient, refetchWalletClient, switchChainAsync, walletClient],
  );

  return {
    ...state,
    execute,
    reset,
    pending: ["switching", "approving", "simulating", "confirming"].includes(state.phase),
  };
}
