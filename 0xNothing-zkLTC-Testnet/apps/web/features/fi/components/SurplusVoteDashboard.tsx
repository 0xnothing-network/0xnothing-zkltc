"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { useAccount, useReadContracts } from "wagmi";
import { HealthGauge } from "@/components/Signature";
import { AmountField } from "@fi/components/AmountField";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import { NotDeployed, TransactionStatus } from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { nusdV2Abi, surplusMintGovernorAbi } from "@fi/lib/abis/tokenomics";
import { formatAmount, parseAmount } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

const VOTE_POLL_MS = 10_000;
const HISTORY = 5;

type Proposal = {
  proposer: Address;
  start: bigint;
  end: bigint;
  yesVotes: number;
  noVotes: number;
  settled: boolean;
  executed: boolean;
  mintedNusd: bigint;
};

type Ballot = { cast: boolean; support: boolean; withdrawn: boolean; incentive: bigint };

function formatDate(seconds: bigint | undefined): string {
  if (seconds === undefined) return "--";
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatRatio(reserve: bigint | undefined, supply: bigint | undefined): string {
  if (reserve === undefined || supply === undefined) return "--";
  if (supply === 0n) return "∞";
  return `${(Number((reserve * 100n) / supply) / 100).toFixed(2)}x`;
}

export function SurplusVoteDashboard() {
  const { address, isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const [fundText, setFundText] = useState("");
  const [nowSeconds, setNowSeconds] = useState<number>();
  const governor = deployment.contracts.surplusMintGovernor;
  const nusd = deployment.contracts.nusd;
  const fundAmount = parseAmount(fundText);

  useEffect(() => {
    const updateClock = () => setNowSeconds(Math.floor(Date.now() / 1000));
    updateClock();
    const timer = window.setInterval(updateClock, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const base = useReadContracts({
    contracts: governor && nusd ? [
      { address: nusd, abi: nusdV2Abi, functionName: "reserveValueNusd" },
      { address: nusd, abi: nusdV2Abi, functionName: "totalSupply" },
      { address: nusd, abi: nusdV2Abi, functionName: "surplusMintCapacity" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "proposalCount" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "VOTE_LOCK" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "MIN_VOTERS" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "incentiveAvailable" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "incentiveFunded" },
      { address: governor, abi: surplusMintGovernorAbi, functionName: "INCENTIVE_BUDGET" },
    ] as const : [],
    query: { enabled: Boolean(governor && nusd), refetchInterval: VOTE_POLL_MS, refetchIntervalInBackground: false },
  });
  // The oracle-priced reads revert while DIA is stale; the page then shows "--" instead of a stale ratio.
  const reserve = base.data?.[0]?.result as bigint | undefined;
  const supply = base.data?.[1]?.result as bigint | undefined;
  const capacity = base.data?.[2]?.result as readonly [bigint, boolean] | undefined;
  const proposalCount = base.data?.[3]?.result as bigint | undefined;
  const voteLock = base.data?.[4]?.result as bigint | undefined;
  const minVoters = base.data?.[5]?.result as bigint | undefined;
  const incentiveAvailable = base.data?.[6]?.result as bigint | undefined;
  const incentiveFunded = base.data?.[7]?.result as bigint | undefined;
  const incentiveBudget = base.data?.[8]?.result as bigint | undefined;
  const triggerReached = capacity?.[1];

  const ids = useMemo(() => {
    if (!proposalCount) return [] as bigint[];
    const first = proposalCount > BigInt(HISTORY) ? proposalCount - BigInt(HISTORY) + 1n : 1n;
    const list: bigint[] = [];
    for (let id = proposalCount; id >= first; id -= 1n) list.push(id);
    return list;
  }, [proposalCount]);
  const proposalReads = useReadContracts({
    contracts: ids.flatMap((id) => [
      { address: governor!, abi: surplusMintGovernorAbi, functionName: "getProposal" as const, args: [id] as const },
      ...(address ? [{ address: governor!, abi: surplusMintGovernorAbi, functionName: "getBallot" as const, args: [id, address] as const }] : []),
    ]),
    query: { enabled: Boolean(governor && ids.length), refetchInterval: VOTE_POLL_MS, refetchIntervalInBackground: false },
  });
  const stride = address ? 2 : 1;
  const history = ids.map((id, index) => ({
    id,
    proposal: proposalReads.data?.[index * stride]?.result as Proposal | undefined,
    ballot: address ? proposalReads.data?.[index * stride + 1]?.result as Ballot | undefined : undefined,
  }));
  const latest = history[0];
  const now = nowSeconds === undefined ? undefined : BigInt(nowSeconds);
  const latestOpen = Boolean(latest?.proposal && !latest.proposal.settled && now !== undefined && now < latest.proposal.end);
  const latestEndedUnsettled = Boolean(latest?.proposal && !latest.proposal.settled && now !== undefined && now >= latest.proposal.end);

  const wallet = useReadContracts({
    contracts: address && nusd ? [{ address: nusd, abi: erc20Abi, functionName: "balanceOf", args: [address] }] as const : [],
    query: { enabled: Boolean(address && nusd), refetchInterval: VOTE_POLL_MS, refetchIntervalInBackground: false },
  });
  const walletNusd = wallet.data?.[0]?.result as bigint | undefined;
  const canLock = walletNusd !== undefined && voteLock !== undefined && walletNusd >= voteLock;

  function refresh() {
    void base.refetch();
    void proposalReads.refetch();
    void wallet.refetch();
  }

  async function run(label: string, detail: string, call: { functionName: string; args?: readonly unknown[] }, lock?: bigint) {
    if (!governor || !nusd) return;
    const hash = await tx.execute({
      approval: lock ? { token: nusd, spender: governor, amount: lock } : undefined,
      call: { address: governor, abi: surplusMintGovernorAbi, ...call },
    });
    if (hash) {
      toast.show(label, detail, "success");
      refresh();
    }
  }

  if (!governor || !nusd) return <NotDeployed feature="The NUSD surplus vote is not deployed on this network yet." />;

  const ratioRisk = reserve !== undefined && supply ? Number((reserve * 1000n) / (supply * 3n)) / 1000 : undefined;
  const latestBallot = latest?.ballot;

  const lockLabel = `${formatAmount(voteLock, 18, 0)} NUSD`;
  let action: ReactNode;
  if (!isConnected) action = <ConnectWalletButton />;
  else if (latestOpen) {
    action = latestBallot?.cast ? (
      <p className="fi-earn-empty" role="status">You voted {latestBallot.support ? "yes" : "no"}. Your {lockLabel} returns when voting ends.</p>
    ) : (
      <div className="fi-vote-actions">
        <button type="button" className="fi-button fi-button-primary" disabled={!canLock || tx.pending} onClick={() => void run("Vote cast", "Yes recorded. Your NUSD is locked until voting ends.", { functionName: "vote", args: [true] }, voteLock)}>Vote yes</button>
        <button type="button" className="fi-button fi-button-muted" disabled={!canLock || tx.pending} onClick={() => void run("Vote cast", "No recorded. Your NUSD is locked until voting ends.", { functionName: "vote", args: [false] }, voteLock)}>Vote no</button>
      </div>
    );
  } else if (latestEndedUnsettled && latest) {
    action = <button type="button" className="fi-button fi-button-block fi-button-primary" disabled={tx.pending} onClick={() => void run("Proposal settled", "The result is final; a passed vote minted at the current reserve.", { functionName: "settle", args: [latest.id] })}>Settle proposal #{latest.id.toString()}</button>;
  } else {
    action = (
      <button type="button" className="fi-button fi-button-block fi-button-primary" disabled={!triggerReached || !canLock || tx.pending} onClick={() => void run("Proposal opened", "You voted yes with 100 NUSD. Voting runs for 3 days.", { functionName: "propose" }, voteLock)}>
        {triggerReached ? `Propose · locks ${lockLabel}` : "Opens when the reserve reaches 3x"}
      </button>
    );
  }

  return (
    <section className="fi-earn" aria-label="NUSD surplus mint vote">
      <article className="fi-panel fi-round" aria-labelledby="vote-overview-title">
        <header className="fi-round-head">
          <div>
            <span className="fi-label">NUSD reserve</span>
            <h2 id="vote-overview-title">Surplus vote</h2>
          </div>
          <span className="fi-status" data-state={triggerReached ? "live" : "warning"}>{triggerReached ? "Proposals open" : "Below 3x"}</span>
        </header>
        <div className="fi-vote-overview">
          <HealthGauge risk={ratioRisk} value={formatRatio(reserve, supply)} caption="Reserve / supply · vote at 3x" warnAt={0.66} dangerAt={1} />
          <dl className="fi-round-stats" aria-label="Reserve overview">
            <div><dt>Reserve value</dt><dd>{formatAmount(reserve, 18, 2)}<small>NUSD</small></dd></div>
            <div><dt>NUSD supply</dt><dd>{formatAmount(supply, 18, 2)}<small>NUSD</small></dd></div>
            <div><dt>Mintable now</dt><dd>{formatAmount(capacity?.[0], 18, 2)}<small>NUSD</small></dd></div>
            <div><dt>Voter incentives</dt><dd>{formatAmount(incentiveAvailable, 18, 0)}<small>/ {formatAmount(incentiveBudget, 18, 0)} NUSD</small></dd></div>
          </dl>
        </div>
        <details className="fi-round-help">
          <summary>Vote rules</summary>
          <ol>
            <li>At 3× reserve/supply anyone can propose; the vote mints NUSD back down to exactly 2×.</li>
            <li>New NUSD goes 50% to the 0xPoints reward pool and 50% to the treasury.</li>
            <li>Voting lasts 3 days; it passes with more yes than no and at least {minVoters?.toString() ?? "10"} voters.</li>
            <li>Each vote locks {lockLabel} until the end, then returns it with 1–10 NUSD while the budget lasts.</li>
            <li>Settlement re-checks 3× with a fresh oracle price; a stale oracle simply mints nothing.</li>
          </ol>
        </details>
      </article>

      <div className="fi-earn-workspace">
        <article className="fi-panel fi-earn-stake" aria-labelledby="vote-current-title">
          <h2 id="vote-current-title" className="fi-earn-title">
            {latest ? `Proposal #${latest.id.toString()}` : "No proposal yet"}
            {latestOpen ? <span className="fi-status" data-state="live">Voting</span> : null}
          </h2>
          {latest?.proposal ? (
            <p className="fi-earn-estimate">
              <span>{latest.proposal.yesVotes} yes · {latest.proposal.noVotes} no</span>
              <span>{latestOpen ? "Ends" : "Ended"} {formatDate(latest.proposal.end)}</span>
            </p>
          ) : null}
          {action}
          {isConnected && !canLock && walletNusd !== undefined ? <p className="fi-earn-empty">Voting needs {lockLabel} in your wallet.</p> : null}
          <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} step={tx.step} totalSteps={tx.totalSteps} />
        </article>

        <article className="fi-panel fi-earn-locks" aria-labelledby="vote-history-title">
          <header className="fi-earn-locks-head">
            <h2 id="vote-history-title" className="fi-earn-title">Recent proposals</h2>
            <span>{proposalCount === undefined ? "--" : proposalCount.toString()}</span>
          </header>
          {history.length === 0 ? (
            <p className="fi-earn-empty">None yet. A proposal can open once the reserve reaches 3× supply.</p>
          ) : (
            <ul className="fi-lock-list">
              {history.map(({ id, proposal, ballot }) => {
                const ended = proposal && now !== undefined && now >= proposal.end;
                const withdrawable = Boolean(ended && ballot?.cast && !ballot.withdrawn);
                const result = !proposal ? "--" : !ended ? "voting" : !proposal.settled ? "awaiting settle" : proposal.executed ? `minted ${formatAmount(proposal.mintedNusd, 18, 0)} NUSD` : "not passed";
                return (
                  <li key={id.toString()}>
                    <div>
                      <strong>#{id.toString()} · {proposal ? `${proposal.yesVotes} yes / ${proposal.noVotes} no` : "--"}</strong>
                      <small>{result}{ballot?.cast ? ` · you voted ${ballot.support ? "yes" : "no"} (+${formatAmount(ballot.incentive, 18, 0)} NUSD)` : ""}</small>
                    </div>
                    {withdrawable ? (
                      <button type="button" className="fi-button fi-button-muted" disabled={tx.pending} onClick={() => void run("NUSD returned", "Your lock and incentive are back in your wallet.", { functionName: "withdraw", args: [id] })}>Withdraw</button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <details className="fi-round-help">
            <summary>Fund voter incentives</summary>
            <AmountField id="vote-fund-nusd" label="Add to budget" asset="NUSD" value={fundText} balance={formatAmount(walletNusd)} helper={`Funded ${formatAmount(incentiveFunded, 18, 0)} of ${formatAmount(incentiveBudget, 18, 0)} NUSD. Anyone can fund; the cap is fixed.`} onChange={setFundText} />
            {isConnected ? (
              <button type="button" className="fi-button fi-button-block fi-button-muted" disabled={!fundAmount || tx.pending} onClick={() => void run("Incentives funded", "Voters draw 1–10 NUSD each from this budget.", { functionName: "fundIncentives", args: [fundAmount] }, fundAmount)}>Fund incentives</button>
            ) : null}
          </details>
        </article>
      </div>
    </section>
  );
}
