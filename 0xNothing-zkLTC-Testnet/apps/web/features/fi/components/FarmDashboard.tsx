"use client";

import { useMemo, useState } from "react";
import { formatUnits, zeroAddress } from "viem";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { AmountField } from "@fi/components/AmountField";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { canonicalPairs, assetForPool, pairSlug, type AssetSymbol } from "@fi/config/assets";
import { deployment } from "@fi/config/deployment";
import { dexFactoryAbi, dexPoolAbi } from "@fi/lib/abis/dex";
import { farmFactoryAbi, farmGaugeAbi } from "@fi/lib/abis/farm";
import { formatAmount, parseAmount, percentageShare } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

function FarmRow({ pair }: { pair: readonly [AssetSymbol, AssetSymbol] }) {
  const [tokenA, tokenB] = pair;
  const addressA = assetForPool(tokenA);
  const addressB = assetForPool(tokenB);
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const [mode, setMode] = useState<"stake" | "withdraw">("stake");
  const [amountText, setAmountText] = useState("");
  const amount = parseAmount(amountText);
  const tx = useProtocolTransaction();
  const poolRead = useReadContract({
    address: deployment.contracts.dexFactory,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args: addressA && addressB ? [addressA, addressB] : undefined,
    query: { enabled: Boolean(deployment.contracts.dexFactory && addressA && addressB) },
  });
  const pool = poolRead.data && poolRead.data !== zeroAddress ? poolRead.data : undefined;
  const gaugeRead = useReadContract({
    address: deployment.contracts.farmFactory,
    abi: farmFactoryAbi,
    functionName: "gaugeForPair",
    args: pool ? [pool] : undefined,
    query: { enabled: Boolean(deployment.contracts.farmFactory && pool), refetchInterval: 15_000 },
  });
  const gauge = gaugeRead.data && gaugeRead.data !== zeroAddress ? gaugeRead.data : undefined;
  const stats = useReadContracts({
    contracts: gauge && pool ? [
      { address: gauge, abi: farmGaugeAbi, functionName: "rewardRate" },
      { address: gauge, abi: farmGaugeAbi, functionName: "periodFinish" },
      { address: gauge, abi: farmGaugeAbi, functionName: "totalSupply" },
      { address: gauge, abi: farmGaugeAbi, functionName: "balanceOf", args: [address || zeroAddress] },
      { address: gauge, abi: farmGaugeAbi, functionName: "earned", args: [address || zeroAddress] },
      { address: pool, abi: dexPoolAbi, functionName: "balanceOf", args: [address || zeroAddress] },
    ] as const : [],
    query: { enabled: Boolean(gauge && pool), refetchInterval: 12_000 },
  });
  const rewardRate = stats.data?.[0]?.result as bigint | undefined;
  const periodFinish = stats.data?.[1]?.result as bigint | undefined;
  const totalStaked = stats.data?.[2]?.result as bigint | undefined;
  const staked = stats.data?.[3]?.result as bigint | undefined;
  const earned = stats.data?.[4]?.result as bigint | undefined;
  const walletLp = stats.data?.[5]?.result as bigint | undefined;
  const available = mode === "stake" ? walletLp : staked;
  const live = Boolean(periodFinish && periodFinish > BigInt(Math.floor(Date.now() / 1000)));
  const invalid = useMemo(() => {
    if (!amountText) return undefined;
    if (!amount) return "Enter a valid LP amount.";
    if (available !== undefined && amount > available) return "Amount exceeds available LP balance.";
    if (mode === "stake" && !live) return "Rewards are not active.";
    return undefined;
  }, [amount, amountText, available, live, mode]);
  const configured = Boolean(pool && gauge);

  async function positionAction() {
    if (!amount || !gauge || !pool) return;
    const hash = await tx.execute({
      approval: mode === "stake" ? { token: pool, spender: gauge, amount } : undefined,
      call: { address: gauge, abi: farmGaugeAbi, functionName: mode, args: [amount] },
    });
    if (hash) {
      toast.show(mode === "stake" ? "LP staked" : "LP withdrawn", `${tokenA}/${tokenB} position updated.`, "success");
      setAmountText(""); void stats.refetch();
    }
  }

  async function claim() {
    if (!gauge) return;
    const hash = await tx.execute({ call: { address: gauge, abi: farmGaugeAbi, functionName: "getReward" } });
    if (hash) { toast.show("Rewards claimed", "Farm rewards were settled to your wallet.", "success"); void stats.refetch(); }
  }

  return (
    <article className="fi-panel fi-farm-row">
      <div className="fi-farm-summary">
        <div><h2>{tokenA}/{tokenB}</h2></div>
        <span className="fi-status" data-state={configured && live ? "live" : configured ? "warning" : "offline"}>{configured ? live ? "LIVE" : "NO REWARDS" : "SETUP"}</span>
      </div>
      {!configured ? <NotDeployed feature={`${tokenA}/${tokenB} farm`} /> : null}
      <dl className="fi-farm-metrics">
        <div><dt>Total staked</dt><dd>{formatAmount(totalStaked)} LP</dd></div>
        <div><dt>Rewards / day</dt><dd>{rewardRate === undefined ? "--" : `${formatAmount(rewardRate * 86_400n)} NUSD`}</dd></div>
        <div><dt>Your stake</dt><dd>{formatAmount(staked)} LP</dd></div>
        <div><dt>Your pool share</dt><dd>{percentageShare(staked, totalStaked)}</dd></div>
        <div><dt>Earned</dt><dd className="positive">{formatAmount(earned)} NUSD</dd></div>
      </dl>
      <div className="fi-farm-actions">
        <div className="fi-segmented" aria-label={`${tokenA}/${tokenB} farm action`}>
          <button type="button" className={mode === "stake" ? "active positive" : ""} onClick={() => { setMode("stake"); setAmountText(""); tx.reset(); }}>Stake</button>
          <button type="button" className={mode === "withdraw" ? "active danger" : ""} onClick={() => { setMode("withdraw"); setAmountText(""); tx.reset(); }}>Withdraw</button>
        </div>
        <AmountField id={`farm-${pairSlug(tokenA, tokenB)}`} label={mode === "stake" ? "Stake" : "Withdraw"} asset="LP" value={amountText} balance={formatAmount(available)} onChange={setAmountText} onMax={available && available > 0n ? () => setAmountText(formatUnits(available, 18)) : undefined} error={invalid} />
        <div className="fi-action-grid">
          <button type="button" className={`fi-button ${mode === "stake" ? "fi-button-primary" : "fi-button-danger"}`} disabled={!configured || (mode === "stake" && !live) || !isConnected || !amount || Boolean(invalid) || tx.pending} onClick={() => void positionAction()}>{tx.pending ? "Processing" : mode === "stake" && !live ? "Rewards inactive" : mode === "stake" ? "Stake LP" : "Withdraw LP"}</button>
          <button type="button" className="fi-button fi-button-muted" disabled={!configured || !isConnected || !earned || tx.pending} onClick={() => void claim()}>Claim rewards</button>
        </div>
        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </div>
    </article>
  );
}

export function FarmDashboard() {
  if (!deployment.contracts.dexFactory || !deployment.contracts.farmFactory) return <NotDeployed feature="LP farming" />;
  return <section className="fi-section-stack" aria-label="Liquidity farms">{canonicalPairs.map((pair) => <FarmRow pair={pair} key={pairSlug(pair[0], pair[1])} />)}</section>;
}
