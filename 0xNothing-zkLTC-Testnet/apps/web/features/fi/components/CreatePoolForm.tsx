"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { ConnectWalletButton } from "@fi/components/ConnectWalletButton";
import {
  NotDeployed,
  PanelHeading,
  TransactionStatus,
} from "@fi/components/UiStates";
import { useToast } from "@fi/components/Toast";
import { deployment } from "@fi/config/deployment";
import { fiPath } from "@fi/config/paths";
import { dexFactoryAbi } from "@fi/lib/abis/dex";
import { erc20Abi } from "@fi/lib/abis/erc20";
import { useProtocolTransaction } from "@fi/lib/hooks/useProtocolTransaction";

const NUSD_ADDRESS = deployment.contracts.nusd;

export function CreatePoolForm() {
  const router = useRouter();
  const { isConnected } = useAccount();
  const toast = useToast();
  const tx = useProtocolTransaction();
  const [tokenAddressText, setTokenAddressText] = useState("");

  const factoryAddress = deployment.contracts.dexFactory;
  const factoryConfigured = Boolean(factoryAddress && NUSD_ADDRESS);

  const trimmedInput = tokenAddressText.trim();
  const inputIsValidAddress = isAddress(trimmedInput);
  const normalizedAddress = inputIsValidAddress
    ? getAddress(trimmedInput)
    : undefined;
  const isNusdSelf = Boolean(
    normalizedAddress &&
      NUSD_ADDRESS &&
      normalizedAddress.toLowerCase() === NUSD_ADDRESS.toLowerCase(),
  );
  const isZero = Boolean(
    normalizedAddress &&
      normalizedAddress.toLowerCase() === zeroAddress,
  );

  const tokenMetadata = useReadContracts({
    contracts: normalizedAddress
      ? [
          { address: normalizedAddress, abi: erc20Abi, functionName: "symbol" },
          { address: normalizedAddress, abi: erc20Abi, functionName: "name" },
          { address: normalizedAddress, abi: erc20Abi, functionName: "decimals" },
        ] as const
      : [],
    query: {
      enabled: Boolean(normalizedAddress && !isNusdSelf && !isZero),
      staleTime: 60_000,
    },
  });

  const symbol = tokenMetadata.data?.[0]?.result as string | undefined;
  const tokenName = tokenMetadata.data?.[1]?.result as string | undefined;
  const decimals = (tokenMetadata.data?.[2]?.result as number | undefined) ?? 18;
  const tokenReadFailed =
    tokenMetadata.data?.some((result) => result.status === "failure") ?? false;
  const tokenMetadataLoading =
    tokenMetadata.isPending ||
    (normalizedAddress !== undefined &&
      !isNusdSelf &&
      !isZero &&
      tokenMetadata.data === undefined &&
      !tokenReadFailed);

  const existingPair = useReadContract({
    address: factoryAddress,
    abi: dexFactoryAbi,
    functionName: "getPair",
    args:
      normalizedAddress && NUSD_ADDRESS && !isNusdSelf && !isZero
        ? [normalizedAddress, NUSD_ADDRESS]
        : undefined,
    query: {
      enabled: Boolean(
        factoryAddress &&
          normalizedAddress &&
          NUSD_ADDRESS &&
          !isNusdSelf &&
          !isZero &&
          !tokenReadFailed &&
          !tokenMetadataLoading,
      ),
      refetchInterval: (query) =>
        query.state.data && query.state.data !== zeroAddress ? false : 10_000,
    },
  });

  const existingPairAddress =
    existingPair.data && existingPair.data !== zeroAddress
      ? (existingPair.data as Address)
      : undefined;

  const inputError = useMemo(() => {
    if (!trimmedInput) return undefined;
    if (!inputIsValidAddress) return "Enter a valid 0x token address.";
    if (isZero) return "The zero address is not a valid token.";
    if (isNusdSelf) return "Enter a token address other than NUSD.";
    if (tokenReadFailed) return "Could not read token metadata from this address.";
    return undefined;
  }, [inputIsValidAddress, isNusdSelf, isZero, tokenReadFailed, trimmedInput]);

  const canCreate =
    factoryConfigured &&
    Boolean(normalizedAddress) &&
    !isNusdSelf &&
    !isZero &&
    !tokenReadFailed &&
    !tokenMetadataLoading &&
    !existingPairAddress &&
    !inputError;

  async function submitCreate() {
    if (!normalizedAddress || !NUSD_ADDRESS || !factoryAddress || !canCreate) return;
    const hash = await tx.execute({
      call: {
        address: factoryAddress,
        abi: dexFactoryAbi,
        functionName: "createPair",
        args: [normalizedAddress, NUSD_ADDRESS],
      },
    });
    if (hash) {
      toast.show(
        "Pool created",
        `${symbol ?? "Token"}/NUSD pool is ready. Redirecting...`,
        "success",
      );
      // Refetch the pair address to redirect to the new pool page.
      const result = await existingPair.refetch();
      const pairAddress = result.data && result.data !== zeroAddress ? (result.data as Address) : undefined;
      if (pairAddress) {
        router.push(fiPath(`/pools/${pairAddress.toLowerCase()}`));
      }
    }
  }

  if (!factoryConfigured) return <NotDeployed feature="DEX factory" />;

  return (
    <section className="fi-panel fi-sticky-panel">
      <PanelHeading title="Create Token/NUSD Pool" />
      <div className="fi-form">
        <label className="fi-field" htmlFor="create-pool-token-address">
          <span className="fi-field-label">Token address</span>
          <input
            id="create-pool-token-address"
            className="fi-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="0x... token contract address"
            value={tokenAddressText}
            onChange={(event) => {
              setTokenAddressText(event.target.value);
              tx.reset();
            }}
            aria-invalid={Boolean(inputError)}
            aria-describedby="create-pool-token-address-error"
          />
          {inputError ? (
            <span
              id="create-pool-token-address-error"
              className="fi-inline-state fi-inline-warning"
              role="status"
            >
              {inputError}
            </span>
          ) : null}
        </label>

        {normalizedAddress && !inputError && tokenMetadataLoading ? (
          <div className="fi-inline-state" role="status">
            <span>Loading token metadata...</span>
          </div>
        ) : null}

        {normalizedAddress && !inputError && !tokenMetadataLoading && symbol ? (
          <dl className="fi-form-details">
            <div>
              <dt>Symbol</dt>
              <dd>{symbol}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd>{tokenName ?? "--"}</dd>
            </div>
            <div>
              <dt>Decimals</dt>
              <dd>{decimals}</dd>
            </div>
            <div>
              <dt>Address</dt>
              <dd className="fi-mono">{normalizedAddress}</dd>
            </div>
          </dl>
        ) : null}

        {existingPairAddress ? (
          <div className="fi-inline-state fi-inline-warning" role="status">
            <div>
              <strong>Pool already exists</strong>
              <p>This token already has an NUSD pool.</p>
            </div>
            <Link
              className="fi-text-link"
              href={fiPath(`/pools/${existingPairAddress.toLowerCase()}`)}
            >
              View pool
            </Link>
          </div>
        ) : null}

        {!existingPairAddress && !inputError && normalizedAddress ? (
          <div className="fi-inline-state" role="status">
            <span>No existing pool found for this token.</span>
          </div>
        ) : null}

        <p className="fi-hint">After the pair is created, you will be redirected to the pool page where you can set liquidity amounts, lock LP, or burn it. Locked and burned pools show badges in the directory.</p>

        {!isConnected ? (
          <ConnectWalletButton />
        ) : (
          <button
            type="button"
            className="fi-button fi-button-primary fi-button-block"
            disabled={!canCreate || tx.pending}
            onClick={() => void submitCreate()}
          >
            {tx.pending ? "Processing" : "Create Pool"}
          </button>
        )}

        <TransactionStatus phase={tx.phase} message={tx.message} hash={tx.hash} />
      </div>
    </section>
  );
}
