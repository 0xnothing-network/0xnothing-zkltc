"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import {
  useAccount,
  useBalance,
  useConfig,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { useToast } from "@/components/Toast";
import { nusdAbi } from "@/features/pump/abis";
import { faucetAbi } from "@/features/faucet/abis";
import { resolveFaucetClaim } from "@/features/faucet/claimState";
import {
  FAUCET_ADDRESS,
  FAUCET_CHAIN_ID,
  FAUCET_CONFIGURED,
  FAUCET_NUSD_ADDRESS,
} from "@/features/faucet/config";
import { formatCompactNumber } from "@/features/pump/format";
import { createPumpWalletGuard } from "@/features/pump/walletSession";
import { releaseAction, tryAcquireAction } from "@/lib/actionLock";
import { waitForProtocolReceipt } from "@/lib/transactionReceipt";

function displayWad(value: bigint | undefined, pending: boolean, digits = 4): string {
  if (pending) return "...";
  if (value === undefined) return "--";
  return formatCompactNumber(Number(formatUnits(value, 18)), digits);
}

export function FaucetPanel() {
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const walletConfig = useConfig();
  const publicClient = usePublicClient({ chainId: FAUCET_CHAIN_ID });
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const submitLockRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const configured = FAUCET_CONFIGURED && Boolean(FAUCET_ADDRESS);
  const wrongChain = isConnected && chainId !== FAUCET_CHAIN_ID;
  const faucetAddress = FAUCET_ADDRESS;
  const nusdAddress = FAUCET_NUSD_ADDRESS;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const nativeDrip = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "nativeDrip",
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const nusdDrip = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "nusdDrip",
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const cooldownSeconds = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "cooldownSeconds",
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const paused = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "paused",
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const remaining = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "dailyRemaining",
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const preview = useReadContract({
    address: faucetAddress,
    abi: faucetAbi,
    functionName: "previewClaim",
    args: address ? [address] : undefined,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured && Boolean(address) },
  });
  const faucetNative = useBalance({
    address: faucetAddress,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured },
  });
  const faucetNusd = useReadContract({
    address: nusdAddress,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: faucetAddress ? [faucetAddress] : undefined,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: configured && Boolean(nusdAddress && faucetAddress) },
  });
  const walletNative = useBalance({
    address,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: Boolean(address) },
  });
  const walletNusd = useReadContract({
    address: nusdAddress,
    abi: nusdAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: FAUCET_CHAIN_ID,
    query: { enabled: Boolean(nusdAddress && address) },
  });

  const readyAt = preview.data ? Number(preview.data[1]) : 0;
  const pending = configured && (
    nativeDrip.isPending
    || nusdDrip.isPending
    || cooldownSeconds.isPending
    || paused.isPending
    || remaining.isPending
    || faucetNative.isPending
    || faucetNusd.isPending
    || (Boolean(address) && preview.isPending)
  );
  const claim = useMemo(() => resolveFaucetClaim({
    configured,
    connected: isConnected,
    wrongChain,
    submitting: isSubmitting,
    pending,
    paused: paused.data,
    now,
    readyAt,
    nativeDrip: nativeDrip.data,
    nusdDrip: nusdDrip.data,
    faucetNativeBalance: faucetNative.data?.value,
    faucetNusdBalance: faucetNusd.data,
    dailyNativeRemaining: remaining.data?.[0],
    dailyNusdRemaining: remaining.data?.[1],
  }), [
    configured,
    faucetNative.data?.value,
    faucetNusd.data,
    isConnected,
    isSubmitting,
    nativeDrip.data,
    now,
    nusdDrip.data,
    paused.data,
    pending,
    readyAt,
    remaining.data,
    wrongChain,
  ]);

  const refresh = async () => {
    await Promise.all([
      nativeDrip.refetch(),
      nusdDrip.refetch(),
      cooldownSeconds.refetch(),
      paused.refetch(),
      remaining.refetch(),
      preview.refetch(),
      faucetNative.refetch(),
      faucetNusd.refetch(),
      walletNative.refetch(),
      walletNusd.refetch(),
    ]);
  };

  const submit = async () => {
    if (!configured || !faucetAddress || !address || !publicClient || claim.disabled) return;
    if (!isConnected) {
      toast.warning("Connect wallet", "Use the wallet control above before claiming.");
      return;
    }
    if (chainId !== FAUCET_CHAIN_ID) {
      switchChain({ chainId: FAUCET_CHAIN_ID });
      return;
    }
    if (!tryAcquireAction(submitLockRef)) return;

    try {
      setIsSubmitting(true);
      const assertWalletUnchanged = createPumpWalletGuard(walletConfig, address);
      assertWalletUnchanged();
      await publicClient.simulateContract({
        account: address,
        address: faucetAddress,
        abi: faucetAbi,
        functionName: "claim",
      });
      assertWalletUnchanged();
      const hash = await writeContractAsync({
        account: address,
        chainId: FAUCET_CHAIN_ID,
        address: faucetAddress,
        abi: faucetAbi,
        functionName: "claim",
      });
      await waitForProtocolReceipt(publicClient, hash);
      await refresh();
      toast.success("Faucet claimed", "zkLTC and NUSD were sent to your wallet.");
    } catch (error) {
      toast.handleError(error, "Could not claim from the faucet");
    } finally {
      releaseAction(submitLockRef);
      setIsSubmitting(false);
    }
  };

  return (
    <section className="pump-panel pump-vault pump-oracle-nusd faucet-panel">
      <div className="pump-panel-heading pump-vault-heading">
        <div>
          <span className="pump-eyebrow">LiteForge testnet</span>
          <h2>Claim zkLTC and NUSD</h2>
        </div>
        <span className="pump-vault-oracle-status" data-state={configured ? "live" : "offline"}>
          {configured ? "READY" : "NOT CONFIGURED"}
        </span>
      </div>

      <p className="faucet-copy">
        Small drips for Pump and 0xFi testing. One claim per wallet every cooldown window,
        with a UTC daily cap. This faucet never exists on mainnet.
      </p>

      <div className="pump-vault-metrics">
        <div>
          <span>Your zkLTC</span>
          <strong>{displayWad(walletNative.data?.value, walletNative.isPending, 4)} zkLTC</strong>
        </div>
        <div>
          <span>Your NUSD</span>
          <strong>{displayWad(walletNusd.data, walletNusd.isPending, 2)}</strong>
        </div>
        <div>
          <span>Drip</span>
          <strong>
            {displayWad(nativeDrip.data, nativeDrip.isPending, 4)} zkLTC
            {" / "}
            {displayWad(nusdDrip.data, nusdDrip.isPending, 2)} NUSD
          </strong>
        </div>
        <div>
          <span>Daily remaining</span>
          <strong>
            {displayWad(remaining.data?.[0], remaining.isPending, 4)} zkLTC
            {" / "}
            {displayWad(remaining.data?.[1], remaining.isPending, 2)} NUSD
          </strong>
        </div>
        <div>
          <span>Cooldown</span>
          <strong>
            {cooldownSeconds.isPending
              ? "..."
              : cooldownSeconds.data === undefined
                ? "--"
                : `${Number(cooldownSeconds.data) / 3600}h`}
          </strong>
        </div>
      </div>

      {!configured ? (
        <p className="pump-vault-alert">
          Set <code>NEXT_PUBLIC_FAUCET_ADDRESS</code> after deploying
          {" "}
          <code>script/DeployFaucet.s.sol</code>
          .
        </p>
      ) : null}

      <button
        type="button"
        className="pump-button pump-button-primary pump-button-large"
        disabled={claim.disabled}
        onClick={() => void submit()}
      >
        {claim.label}
      </button>
    </section>
  );
}
