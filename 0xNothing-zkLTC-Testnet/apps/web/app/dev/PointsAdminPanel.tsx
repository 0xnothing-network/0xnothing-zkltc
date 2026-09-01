"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  formatUnits,
  getAddress,
  isAddress,
  maxUint256,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useSignMessage,
} from "wagmi";
import { deployment } from "@fi/config/deployment";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { nusdPointsStakingAbi, POINTS_PER_XPOINT } from "@fi/lib/abis/points";
import { formatAmount, formatFixedAmount, parseAmount, shortAddress } from "@fi/lib/format";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";
import {
  buildPointsVoucherAuthorizationMessage,
  POINTS_EIP712_NAME,
  POINTS_EIP712_VERSION,
  pointsVoucherTypes,
  type PointsVoucherAuthorization,
} from "@fi/lib/pointsVoucher";
import { STEADY_LIVE_MS } from "@/lib/liveData";
import { jitteredPollInterval } from "@/lib/pollJitter";
import styles from "./dev.module.css";

const POINTS_ADMIN_POLL_MS = jitteredPollInterval("points-admin", STEADY_LIVE_MS);
const VOUCHER_TTL_SECONDS = 5 * 60;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const DECIMAL_UINT = /^(0|[1-9]\d{0,77})$/;

interface SignedVoucherResponse {
  voucher: {
    account: Address;
    recipient: Address;
    pointCredits: string;
    nonce: string;
    deadline: string;
    rateVersion: string;
  };
  signature: Hex;
  signer: Address;
  nusdOut: string;
}

function normalizedAddress(value: string): Address | undefined {
  const candidate = value.trim();
  if (!isAddress(candidate) || candidate.toLowerCase() === zeroAddress) return undefined;
  return getAddress(candidate);
}

function sameAddress(left?: string, right?: string): boolean {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function validUint256(value: unknown): value is string {
  return typeof value === "string"
    && DECIMAL_UINT.test(value)
    && BigInt(value) <= maxUint256;
}

function validSignedVoucher(
  value: unknown,
  authorization: PointsVoucherAuthorization,
  expectedSigner: Address,
  expectedNusdOut: bigint,
): value is SignedVoucherResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (!result.voucher || typeof result.voucher !== "object" || Array.isArray(result.voucher)) return false;
  const voucher = result.voucher as Record<string, unknown>;
  if (
    typeof voucher.account !== "string"
    || typeof voucher.recipient !== "string"
    || typeof voucher.pointCredits !== "string"
    || typeof voucher.nonce !== "string"
    || typeof voucher.deadline !== "string"
    || typeof voucher.rateVersion !== "string"
    || typeof result.signature !== "string"
    || typeof result.signer !== "string"
    || typeof result.nusdOut !== "string"
    || !isAddress(voucher.account)
    || !isAddress(voucher.recipient)
    || !isAddress(result.signer)
    || !validUint256(voucher.pointCredits)
    || !validUint256(voucher.nonce)
    || !validUint256(voucher.deadline)
    || !validUint256(voucher.rateVersion)
    || !validUint256(result.nusdOut)
    || !SIGNATURE_PATTERN.test(result.signature)
  ) return false;

  return sameAddress(voucher.account, authorization.account)
    && sameAddress(voucher.recipient, authorization.recipient)
    && voucher.pointCredits === authorization.pointCredits
    && voucher.nonce === authorization.nonce
    && voucher.deadline === authorization.deadline
    && voucher.rateVersion === authorization.rateVersion
    && sameAddress(result.signer, expectedSigner)
    && result.nusdOut === expectedNusdOut.toString();
}

export function PointsAdminPanel() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync, isPending: isSigning } = useSignMessage();
  const tx = useProtocolTransaction();
  const staking = deployment.contracts.nusdPointsStaking;
  const nusd = deployment.contracts.nusd;

  const [fundAmountText, setFundAmountText] = useState("");
  const [withdrawAmountText, setWithdrawAmountText] = useState("");
  const [withdrawRecipientText, setWithdrawRecipientText] = useState("");
  const [rateText, setRateText] = useState("");
  const [rateTouched, setRateTouched] = useState(false);
  const [nextEnabled, setNextEnabled] = useState(false);
  const [enabledTouched, setEnabledTouched] = useState(false);
  const [newSignerText, setNewSignerText] = useState("");
  const [newGuardianText, setNewGuardianText] = useState("");
  const [voucherAccountText, setVoucherAccountText] = useState("");
  const [voucherRecipientText, setVoucherRecipientText] = useState("");
  const [xPointsText, setXPointsText] = useState("");
  const [confirmFunding, setConfirmFunding] = useState(false);
  const [confirmWithdrawal, setConfirmWithdrawal] = useState(false);
  const [confirmConfig, setConfirmConfig] = useState(false);
  const [confirmRoles, setConfirmRoles] = useState(false);
  const [confirmVoucher, setConfirmVoucher] = useState(false);
  const [apiError, setApiError] = useState<string>();
  const [signedVoucher, setSignedVoucher] = useState<SignedVoucherResponse>();
  const [isIssuingVoucher, setIsIssuingVoucher] = useState(false);
  const previousAddressRef = useRef<Address | undefined>(undefined);
  const voucherIssueVersionRef = useRef(0);
  const voucherIssueInFlightRef = useRef(false);
  const voucherRequestAbortRef = useRef<AbortController | undefined>(undefined);

  const invalidateVoucherIssue = useCallback(() => {
    voucherIssueVersionRef.current += 1;
    voucherRequestAbortRef.current?.abort();
    voucherRequestAbortRef.current = undefined;
  }, []);

  const protocol = useReadContracts({
    contracts: staking ? [
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "owner" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "guardian" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "redemptionSigner" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "stakingPaused" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "redemptionsPaused" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "redemptionEnabled" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "nusdPerXPointWad" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "rateVersion" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "redemptionReserve" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "totalLocked" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "excessNusd" },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "isSolvent" },
    ] as const : [],
    query: {
      enabled: Boolean(staking),
      refetchInterval: POINTS_ADMIN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const operatorNusd = useReadContract({
    chainId: deployment.chain.id,
    address: nusd,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: {
      enabled: Boolean(nusd && address),
      refetchInterval: POINTS_ADMIN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });

  const owner = protocol.data?.[0]?.result as Address | undefined;
  const guardian = protocol.data?.[1]?.result as Address | undefined;
  const redemptionSigner = protocol.data?.[2]?.result as Address | undefined;
  const stakingPaused = protocol.data?.[3]?.result as boolean | undefined;
  const redemptionsPaused = protocol.data?.[4]?.result as boolean | undefined;
  const redemptionEnabled = protocol.data?.[5]?.result as boolean | undefined;
  const rate = protocol.data?.[6]?.result as bigint | undefined;
  const rateVersion = protocol.data?.[7]?.result as bigint | undefined;
  const reserve = protocol.data?.[8]?.result as bigint | undefined;
  const totalLocked = protocol.data?.[9]?.result as bigint | undefined;
  const excess = protocol.data?.[10]?.result as bigint | undefined;
  const solvent = protocol.data?.[11]?.result as boolean | undefined;

  useEffect(() => {
    if (!rateTouched && rate !== undefined) setRateText(formatUnits(rate, 18));
  }, [rate, rateTouched]);
  useEffect(() => {
    if (!enabledTouched && redemptionEnabled !== undefined) {
      setNextEnabled(redemptionEnabled);
    }
  }, [enabledTouched, redemptionEnabled]);
  useEffect(() => {
    invalidateVoucherIssue();
    const previousAddress = previousAddressRef.current;
    setWithdrawRecipientText((current) => {
      if (!address) return sameAddress(current, previousAddress) ? "" : current;
      return !current.trim() || sameAddress(current, previousAddress) ? address : current;
    });
    previousAddressRef.current = address;
    setConfirmFunding(false);
    setConfirmWithdrawal(false);
    setConfirmConfig(false);
    setConfirmRoles(false);
    setConfirmVoucher(false);
    setRateTouched(false);
    setEnabledTouched(false);
    setApiError(undefined);
    setSignedVoucher(undefined);
  }, [address, chainId, invalidateVoucherIssue]);

  const voucherAccount = normalizedAddress(voucherAccountText);
  const voucherRecipient = normalizedAddress(voucherRecipientText);
  const xPointsWad = parseAmount(xPointsText);
  const voucherPointCredits = xPointsWad ? xPointsWad * POINTS_PER_XPOINT : undefined;
  const voucherState = useReadContracts({
    contracts: staking && voucherAccount ? [
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "availablePointCredits", args: [voucherAccount] },
      { chainId: deployment.chain.id, address: staking, abi: nusdPointsStakingAbi, functionName: "redemptionNonces", args: [voucherAccount] },
    ] as const : [],
    query: {
      enabled: Boolean(staking && voucherAccount),
      refetchInterval: POINTS_ADMIN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const availableCredits = voucherState.data?.[0]?.result as bigint | undefined;
  const voucherNonce = voucherState.data?.[1]?.result as bigint | undefined;
  const voucherQuoteState = useReadContract({
    chainId: deployment.chain.id,
    address: staking,
    abi: nusdPointsStakingAbi,
    functionName: "quoteRedemption",
    args: voucherPointCredits ? [voucherPointCredits] : undefined,
    query: {
      enabled: Boolean(staking && voucherAccount && voucherPointCredits),
      refetchInterval: POINTS_ADMIN_POLL_MS,
      refetchIntervalInBackground: false,
    },
  });
  const voucherQuote = voucherQuoteState.data as bigint | undefined;

  useEffect(() => {
    setConfirmConfig(false);
  }, [rate, rateVersion, redemptionEnabled]);
  useEffect(() => {
    setConfirmVoucher(false);
  }, [availableCredits, rateVersion, redemptionEnabled, redemptionsPaused, reserve, solvent, voucherNonce, voucherQuote]);
  useEffect(() => {
    invalidateVoucherIssue();
    setSignedVoucher(undefined);
  }, [invalidateVoucherIssue, rateVersion, redemptionSigner, voucherNonce]);

  useEffect(() => () => invalidateVoucherIssue(), [invalidateVoucherIssue]);

  const fundAmount = parseAmount(fundAmountText);
  const reserveWithdrawalAmount = parseAmount(withdrawAmountText);
  const reserveWithdrawalRecipient = normalizedAddress(withdrawRecipientText);
  const nextRate = parseAmount(rateText);
  const newSigner = normalizedAddress(newSignerText);
  const newGuardian = normalizedAddress(newGuardianText);
  const isOwner = sameAddress(address, owner);
  const isGuardian = sameAddress(address, guardian);
  const correctChain = chainId === deployment.chain.id;
  const pending = tx.pending || isSigning || isIssuingVoucher;
  const baseDisabled = !isConnected || !correctChain || pending || !staking;
  const signerAddressAllowed = Boolean(
    newSigner
    && !sameAddress(newSigner, owner)
    && !sameAddress(newSigner, guardian)
    && !sameAddress(newSigner, redemptionSigner),
  );
  const guardianAddressAllowed = Boolean(
    newGuardian
    && !sameAddress(newGuardian, owner)
    && !sameAddress(newGuardian, guardian)
    && !sameAddress(newGuardian, redemptionSigner),
  );
  const voucherRecipientAllowed = Boolean(
    voucherRecipient && !sameAddress(voucherRecipient, staking),
  );
  const voucherReady = Boolean(
    voucherAccount
    && voucherRecipientAllowed
    && voucherPointCredits
    && voucherNonce !== undefined
    && rateVersion !== undefined
    && redemptionSigner
    && redemptionEnabled
    && !redemptionsPaused
    && solvent
    && availableCredits !== undefined
    && voucherPointCredits <= availableCredits
    && voucherQuote
    && reserve !== undefined
    && voucherQuote <= reserve,
  );
  const signedVoucherReady = (() => {
    if (
      !signedVoucher
      || !redemptionEnabled
      || redemptionsPaused
      || !solvent
      || !redemptionSigner
      || !sameAddress(signedVoucher.signer, redemptionSigner)
      || availableCredits === undefined
      || voucherNonce === undefined
      || rateVersion === undefined
      || reserve === undefined
      || !voucherAccount
      || !voucherRecipient
      || !voucherPointCredits
      || voucherQuote === undefined
    ) return false;
    const pointCredits = BigInt(signedVoucher.voucher.pointCredits);
    const nusdOut = BigInt(signedVoucher.nusdOut);
    return sameAddress(signedVoucher.voucher.account, voucherAccount)
      && sameAddress(signedVoucher.voucher.recipient, voucherRecipient)
      && pointCredits === voucherPointCredits
      && nusdOut === voucherQuote
      && BigInt(signedVoucher.voucher.nonce) === voucherNonce
      && BigInt(signedVoucher.voucher.rateVersion) === rateVersion
      && BigInt(signedVoucher.voucher.deadline) > BigInt(Math.floor(Date.now() / 1000))
      && pointCredits <= availableCredits
      && nusdOut > 0n
      && nusdOut <= reserve;
  })();

  function refresh() {
    void protocol.refetch();
    void operatorNusd.refetch();
    void voucherState.refetch();
    if (voucherPointCredits) void voucherQuoteState.refetch();
  }

  function clearVoucherResult() {
    invalidateVoucherIssue();
    setApiError(undefined);
    setSignedVoucher(undefined);
    setConfirmVoucher(false);
  }

  async function fundReserve() {
    if (!staking || !nusd || !fundAmount || !confirmFunding) return;
    const hash = await tx.execute({
      approval: { token: nusd, spender: staking, amount: fundAmount },
      call: { address: staking, abi: nusdPointsStakingAbi, functionName: "fundRedemptionReserve", args: [fundAmount] },
    });
    if (hash) {
      setFundAmountText("");
      setConfirmFunding(false);
      refresh();
    }
  }

  async function withdrawReserve() {
    if (!staking || !reserveWithdrawalAmount || !reserveWithdrawalRecipient || !confirmWithdrawal) return;
    const hash = await tx.execute({
      call: {
        address: staking,
        abi: nusdPointsStakingAbi,
        functionName: "withdrawRedemptionReserve",
        args: [reserveWithdrawalRecipient, reserveWithdrawalAmount],
      },
    });
    if (hash) {
      setWithdrawAmountText("");
      setConfirmWithdrawal(false);
      refresh();
    }
  }

  async function configureRedemption() {
    const configuredRate = nextRate ?? (nextEnabled ? undefined : 0n);
    if (!staking || configuredRate === undefined || !confirmConfig) return;
    const hash = await tx.execute({
      call: {
        address: staking,
        abi: nusdPointsStakingAbi,
        functionName: "configureRedemption",
        args: [configuredRate, nextEnabled],
      },
    });
    if (hash) {
      setConfirmConfig(false);
      setRateTouched(false);
      setEnabledTouched(false);
      setSignedVoucher(undefined);
      refresh();
    }
  }

  async function setPause(kind: "staking" | "redemptions", paused: boolean) {
    if (!staking) return;
    const label = `${paused ? "pause" : "unpause"} ${kind}`;
    if (!window.confirm(`Confirm ${label}. The wallet and contract will enforce your role.`)) return;
    const functionName = kind === "staking"
      ? paused ? "pauseStaking" : "unpauseStaking"
      : paused ? "pauseRedemptions" : "unpauseRedemptions";
    const hash = await tx.execute({
      call: { address: staking, abi: nusdPointsStakingAbi, functionName },
    });
    if (hash) refresh();
  }

  async function rotateRole(kind: "signer" | "guardian") {
    const nextAddress = kind === "signer" ? newSigner : newGuardian;
    const addressAllowed = kind === "signer" ? signerAddressAllowed : guardianAddressAllowed;
    if (!staking || !nextAddress || !confirmRoles || !addressAllowed) return;
    const hash = await tx.execute({
      call: {
        address: staking,
        abi: nusdPointsStakingAbi,
        functionName: kind === "signer" ? "setRedemptionSigner" : "setGuardian",
        args: [nextAddress],
      },
    });
    if (hash) {
      if (kind === "signer") setNewSignerText("");
      else setNewGuardianText("");
      setConfirmRoles(false);
      setSignedVoucher(undefined);
      refresh();
    }
  }

  async function issueVoucher() {
    if (
      !address
      || !staking
      || !voucherAccount
      || !voucherRecipient
      || !voucherRecipientAllowed
      || !voucherPointCredits
      || voucherNonce === undefined
      || rateVersion === undefined
      || !redemptionSigner
      || voucherQuote === undefined
      || !voucherReady
      || !isOwner
      || !correctChain
      || !confirmVoucher
      || voucherIssueInFlightRef.current
    ) return;

    voucherIssueInFlightRef.current = true;
    setIsIssuingVoucher(true);
    const issueVersion = voucherIssueVersionRef.current + 1;
    voucherIssueVersionRef.current = issueVersion;
    const abortController = new AbortController();
    voucherRequestAbortRef.current = abortController;
    setApiError(undefined);
    setSignedVoucher(undefined);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const authorization: PointsVoucherAuthorization = {
      domain: window.location.host.toLowerCase(),
      admin: address,
      contract: staking,
      chainId: deployment.chain.id,
      account: voucherAccount,
      recipient: voucherRecipient,
      pointCredits: voucherPointCredits.toString(),
      nonce: voucherNonce.toString(),
      deadline: String(nowSeconds + VOUCHER_TTL_SECONDS),
      rateVersion: rateVersion.toString(),
      issuedAt: new Date().toISOString(),
      requestNonce: crypto.randomUUID().replaceAll("-", ""),
    };
    const message = buildPointsVoucherAuthorizationMessage(authorization);
    try {
      const signature = await signMessageAsync({ message });
      if (voucherIssueVersionRef.current !== issueVersion) return;
      const response = await fetch("/api/dev/points/voucher", {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authorization, message, signature }),
        signal: abortController.signal,
      });
      const body = await response.json().catch(() => ({})) as unknown;
      if (voucherIssueVersionRef.current !== issueVersion) return;
      if (!response.ok) {
        const error = body && typeof body === "object" && "error" in body && typeof body.error === "string"
          ? body.error
          : "Voucher signing failed";
        throw new Error(error);
      }
      if (!validSignedVoucher(body, authorization, redemptionSigner, voucherQuote)) {
        throw new Error("Voucher signer returned an invalid or mismatched payload");
      }
      const signatureValid = await verifyTypedData({
        address: redemptionSigner,
        domain: {
          name: POINTS_EIP712_NAME,
          version: POINTS_EIP712_VERSION,
          chainId: deployment.chain.id,
          verifyingContract: staking,
        },
        types: pointsVoucherTypes,
        primaryType: "RedeemVoucher",
        message: {
          account: body.voucher.account,
          recipient: body.voucher.recipient,
          pointCredits: BigInt(body.voucher.pointCredits),
          nonce: BigInt(body.voucher.nonce),
          deadline: BigInt(body.voucher.deadline),
          rateVersion: BigInt(body.voucher.rateVersion),
        },
        signature: body.signature,
      });
      if (voucherIssueVersionRef.current !== issueVersion) return;
      if (!signatureValid) {
        throw new Error("Voucher signer returned an invalid signature");
      }
      setSignedVoucher(body);
      setConfirmVoucher(false);
    } catch (error) {
      if (voucherIssueVersionRef.current !== issueVersion || abortController.signal.aborted) return;
      setApiError(error instanceof Error ? error.message : "Voucher signing failed");
    } finally {
      if (voucherRequestAbortRef.current === abortController) {
        voucherRequestAbortRef.current = undefined;
      }
      voucherIssueInFlightRef.current = false;
      setIsIssuingVoucher(false);
    }
  }

  async function relayVoucher() {
    if (!staking || !signedVoucher || !signedVoucherReady) return;
    const voucher = {
      account: signedVoucher.voucher.account,
      recipient: signedVoucher.voucher.recipient,
      pointCredits: BigInt(signedVoucher.voucher.pointCredits),
      nonce: BigInt(signedVoucher.voucher.nonce),
      deadline: BigInt(signedVoucher.voucher.deadline),
      rateVersion: BigInt(signedVoucher.voucher.rateVersion),
    };
    const hash = await tx.execute({
      call: {
        address: staking,
        abi: nusdPointsStakingAbi,
        functionName: "redeem",
        args: [voucher, signedVoucher.signature],
      },
    });
    if (hash) {
      setSignedVoucher(undefined);
      setXPointsText("");
      refresh();
    }
  }

  const programState = useMemo(() => {
    if (!staking) return "Not deployed";
    if (solvent === false) return "Insolvent — emergency stop";
    if (redemptionsPaused) return "Redemptions paused";
    if (!redemptionEnabled) return "Redemption disabled";
    return "Active";
  }, [redemptionEnabled, redemptionsPaused, solvent, staking]);

  return (
    <section className={styles.section} aria-label="NUSD xPoints administration" aria-busy={pending}>
      <div className={styles.sectionHeader}>
        <div><span className={styles.eyebrow}>NUSD xPoints / on-chain</span><h2>Stake and private voucher controls</h2></div>
        <p className={styles.sectionNote}>The auxiliary signer remains server-only. The connected on-chain owner must authorize each voucher; no private key is exposed to this page.</p>
      </div>

      {!staking || !nusd ? (
        <div className={styles.banner}><span>xPoints staking is not published. Deploy the optional contract, verify it, then publish the same address to the web manifest and server signer configuration.</span></div>
      ) : null}
      {apiError ? <div className={`${styles.banner} ${styles.bannerError}`} role="alert"><span>{apiError}</span></div> : null}
      {tx.phase !== "idle" ? <div className={`${styles.banner} ${tx.phase === "error" ? styles.bannerError : ""}`} role={tx.phase === "error" ? "alert" : "status"} aria-live="polite"><span>{tx.message || tx.phase}{tx.hash ? ` · ${tx.hash.slice(0, 10)}...` : ""}</span></div> : null}

      <div className={`${styles.grid} ${styles.gridThree}`}>
        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Program health</span><span>{programState}</span></div>
          <strong className={styles.value}>{formatAmount(totalLocked)} NUSD</strong>
          <span className={styles.subvalue}>Locked principal · reserve {formatAmount(reserve)} NUSD · excess {formatAmount(excess)} NUSD</span>
          <span className={styles.address}>Owner: {owner ? shortAddress(owner) : "Loading"}<br />Guardian: {guardian ? shortAddress(guardian) : "Loading"}<br />Signer: {redemptionSigner ? shortAddress(redemptionSigner) : "Loading"}<br />Solvent: {solvent === undefined ? "Loading" : solvent ? "yes" : "NO"}</span>
          <div className={styles.stackActions}>
            <button className={styles.button} disabled={baseDisabled || (!isOwner && !isGuardian) || Boolean(stakingPaused)} onClick={() => void setPause("staking", true)}>Pause new stakes</button>
            <button className={styles.button} disabled={baseDisabled || !isOwner || !stakingPaused} onClick={() => void setPause("staking", false)}>Unpause stakes</button>
            <button className={styles.button} disabled={baseDisabled || (!isOwner && !isGuardian) || Boolean(redemptionsPaused)} onClick={() => void setPause("redemptions", true)}>Pause redemptions</button>
            <button className={styles.button} disabled={baseDisabled || !isOwner || !redemptionsPaused} onClick={() => void setPause("redemptions", false)}>Unpause redemptions</button>
          </div>
        </div>

        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Redemption reserve</span><span>{formatAmount(operatorNusd.data as bigint | undefined)} NUSD wallet</span></div>
          <div className={styles.field}><label htmlFor="points-fund">Fund isolated reserve</label><input id="points-fund" inputMode="decimal" value={fundAmountText} onChange={(event) => { setFundAmountText(event.target.value); setConfirmFunding(false); }} placeholder="0" /></div>
          <label className={styles.checkbox}><input type="checkbox" checked={confirmFunding} onChange={(event) => setConfirmFunding(event.target.checked)} />I verified this amount funds only the separate redemption reserve.</label>
          <button className={styles.button} disabled={baseDisabled || !fundAmount || !confirmFunding || (operatorNusd.data as bigint | undefined ?? 0n) < fundAmount} onClick={() => void fundReserve()}>Approve and fund reserve</button>
          <div className={styles.field}><label htmlFor="points-reserve-recipient">Reserve withdrawal recipient</label><input id="points-reserve-recipient" value={withdrawRecipientText} onChange={(event) => { setWithdrawRecipientText(event.target.value); setConfirmWithdrawal(false); }} placeholder="0x..." autoComplete="off" spellCheck={false} /></div>
          <div className={styles.field}><label htmlFor="points-reserve-withdraw">Reserve withdrawal amount</label><input id="points-reserve-withdraw" inputMode="decimal" value={withdrawAmountText} onChange={(event) => { setWithdrawAmountText(event.target.value); setConfirmWithdrawal(false); }} placeholder="0" /></div>
          <label className={styles.checkbox}><input type="checkbox" checked={confirmWithdrawal} onChange={(event) => setConfirmWithdrawal(event.target.checked)} />I understand this reduces funds available for xPoints redemption.</label>
          <button className={`${styles.button} ${styles.buttonDanger}`} disabled={baseDisabled || !isOwner || !reserveWithdrawalAmount || !reserveWithdrawalRecipient || !confirmWithdrawal || (reserve ?? 0n) < reserveWithdrawalAmount} onClick={() => void withdrawReserve()}>Withdraw reserve</button>
        </div>

        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Redemption policy</span><span>Version {rateVersion?.toString() ?? "--"}</span></div>
          <strong className={styles.value}>{formatAmount(rate, 18, 6)} NUSD</strong>
          <span className={styles.subvalue}>Current NUSD per 1.00xPoints</span>
          <div className={styles.field}><label htmlFor="points-rate">New NUSD per xPoints</label><input id="points-rate" inputMode="decimal" value={rateText} onChange={(event) => { setRateText(event.target.value); setRateTouched(true); setConfirmConfig(false); }} placeholder="0" /></div>
          <label className={styles.checkbox}><input type="checkbox" checked={nextEnabled} onChange={(event) => { setNextEnabled(event.target.checked); setEnabledTouched(true); setConfirmConfig(false); }} />Enable voucher redemption at this rate.</label>
          <label className={styles.checkbox}><input type="checkbox" checked={confirmConfig} onChange={(event) => setConfirmConfig(event.target.checked)} />I verified the conversion rate. Updating it invalidates every unredeemed voucher.</label>
          <button className={`${styles.button} ${styles.buttonDanger}`} disabled={baseDisabled || !isOwner || (nextEnabled && !nextRate) || !confirmConfig || (rate === (nextRate ?? 0n) && redemptionEnabled === nextEnabled)} onClick={() => void configureRedemption()}>Update redemption policy</button>
        </div>

        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Auxiliary roles</span><span>Owner only</span></div>
          <div className={styles.field}><label htmlFor="points-new-signer">New offline signer address</label><input id="points-new-signer" value={newSignerText} onChange={(event) => { setNewSignerText(event.target.value); setConfirmRoles(false); }} placeholder="0x..." autoComplete="off" spellCheck={false} /></div>
          <button className={styles.button} disabled={baseDisabled || !isOwner || !signerAddressAllowed || !confirmRoles} onClick={() => void rotateRole("signer")}>Rotate voucher signer</button>
          <div className={styles.field}><label htmlFor="points-new-guardian">New guardian address</label><input id="points-new-guardian" value={newGuardianText} onChange={(event) => { setNewGuardianText(event.target.value); setConfirmRoles(false); }} placeholder="0x..." autoComplete="off" spellCheck={false} /></div>
          <button className={styles.button} disabled={baseDisabled || !isOwner || !guardianAddressAllowed || !confirmRoles} onClick={() => void rotateRole("guardian")}>Rotate guardian</button>
          <label className={styles.checkbox}><input type="checkbox" checked={confirmRoles} onChange={(event) => setConfirmRoles(event.target.checked)} />I verified the new address independently. The signer must be a fresh, unfunded EOA and must never equal the deployer key.</label>
        </div>

        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Issue one voucher</span><span>Owner wallet + server signer</span></div>
          <div className={styles.field}><label htmlFor="points-voucher-account">xPoints account</label><input id="points-voucher-account" value={voucherAccountText} onChange={(event) => { setVoucherAccountText(event.target.value); clearVoucherResult(); }} placeholder="0x..." autoComplete="off" spellCheck={false} /></div>
          <div className={styles.field}><label htmlFor="points-voucher-recipient">NUSD recipient</label><input id="points-voucher-recipient" value={voucherRecipientText} onChange={(event) => { setVoucherRecipientText(event.target.value); clearVoucherResult(); }} placeholder="0x..." autoComplete="off" spellCheck={false} /></div>
          <div className={styles.field}><label htmlFor="points-voucher-amount">Redeem xPoints</label><input id="points-voucher-amount" inputMode="decimal" value={xPointsText} onChange={(event) => { setXPointsText(event.target.value); clearVoucherResult(); }} placeholder="0" /></div>
          <span className={styles.address}>Available: {availableCredits === undefined ? "--" : formatFixedAmount(availableCredits, 20)}xPoints<br />Quote: {formatAmount(voucherQuote, 18, 6)} NUSD · nonce {voucherNonce?.toString() ?? "--"}</span>
          <label className={styles.checkbox}><input type="checkbox" checked={confirmVoucher} onChange={(event) => setConfirmVoucher(event.target.checked)} />I verified account, recipient, amount and quote. The wallet signature authorizes only this five-minute voucher.</label>
          <button className={styles.button} disabled={baseDisabled || !isOwner || !voucherReady || !confirmVoucher || isSigning || isIssuingVoucher} onClick={() => void issueVoucher()}>{isSigning ? "Signing owner authorization" : isIssuingVoucher ? "Creating signed voucher" : "Create signed voucher"}</button>
          {signedVoucher ? <button className={`${styles.button} ${styles.buttonDanger}`} disabled={baseDisabled || !signedVoucherReady} onClick={() => void relayVoucher()}>Redeem {formatAmount(BigInt(signedVoucher.nusdOut), 18, 6)} NUSD on-chain</button> : null}
        </div>

        <div className={`${styles.card} ${styles.formCard}`}>
          <div className={styles.cardTop}><span>Security boundary</span><span>Fail closed</span></div>
          <strong className={styles.value}>No client key</strong>
          <span className={styles.subvalue}>A voucher requires both the connected owner authorization and the isolated server key.</span>
          <p>Rate changes invalidate outstanding vouchers. Account nonces block replay. Recipients are signed. Locked stake principal is excluded from the redemption reserve and remains withdrawable after maturity even while staking or redemptions are paused.</p>
          <span className={styles.address}>Connected role: {isOwner ? "owner" : isGuardian ? "guardian" : "read only"}<br />Network: {correctChain ? deployment.chain.name : `wrong chain ${chainId}`}</span>
        </div>
      </div>
    </section>
  );
}
