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
  amount: bigint;
}

interface ExecuteOptions {
  call: ProtocolCall;
  approval?: TokenApproval | readonly TokenApproval[];
}

interface TransactionState {
  phase: TransactionPhase;
  message: string;
  hash?: Hash;
}

const INITIAL_STATE: TransactionState = { phase: "idle", message: "" };

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
    async ({ call, approval }: ExecuteOptions): Promise<Hash | undefined> => {
      if (inFlightRef.current) return undefined;
      if (!call.address) {
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

        const approvals = approval ? (Array.isArray(approval) ? approval : [approval]) : [];
        for (const [approvalIndex, item] of approvals.entries()) {
          if (item.token && item.spender && item.amount > 0n) {
            const allowance = await publicClient.readContract({
              address: item.token,
              abi: erc20Abi,
              functionName: "allowance",
              args: [address, item.spender],
            });

            if (allowance < item.amount) {
              setState({
                phase: "approving",
                message: `Step ${approvalIndex + 1}/${approvals.length + 1} · Approve token`,
              });
              const approvalSimulation = await publicClient.simulateContract({
                account: address,
                address: item.token,
                abi: erc20Abi,
                functionName: "approve",
                args: [item.spender, item.amount],
              });
              const approvalHash = await wallet.writeContract(approvalSimulation.request);
              const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
              if (approvalReceipt.status !== "success") throw new Error("Token approval reverted");
            }
          }
        }

        setState({ phase: "simulating", message: "Checking latest on-chain state" });
        const simulation = await publicClient.simulateContract({
          account: address,
          address: call.address,
          abi: call.abi,
          functionName: call.functionName,
          args: call.args,
          value: call.value,
        });

        setState({
          phase: "confirming",
          message: `Step ${approvals.length + 1}/${approvals.length + 1} · Confirm transaction`,
        });
        const hash = await wallet.writeContract(simulation.request);
        setState({ phase: "confirming", message: "Submitted · Confirming on-chain", hash });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error("Transaction reverted");

        void queryClient.invalidateQueries({
          predicate: (query) => isBlockSyncedQueryKey(query.queryKey),
        });
        setState({ phase: "success", message: "Confirmed on LitVM", hash });
        return hash;
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
