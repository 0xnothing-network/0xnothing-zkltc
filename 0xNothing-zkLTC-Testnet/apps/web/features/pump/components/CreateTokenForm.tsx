"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  decodeEventLog,
  formatUnits,
  getAddress,
  maxUint256,
  type Address,
  type Hex,
} from "viem";
import {
  useAccount,
  usePublicClient,
  useReadContract,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { zeroXPumpAbi, nusdAbi } from "@/features/pump/abis";
import {
  NUSD_CONFIGURED,
  PUMP_CHAIN_ID,
  PUMP_CONFIGURED,
  PUMP_CREATE_FEE,
  PUMP_FACTORY_ADDRESS,
  PUMP_NUSD_ADDRESS,
  ZERO_ADDRESS,
} from "@/features/pump/config";
import { useIpfsUpload } from "@/features/pump/hooks/useIpfsUpload";
import { computePumpContentHash } from "@/features/pump/contentHash";
import { PUMP_MAX_IMAGE_BYTES, validatePumpImage } from "@/features/pump/imageValidation";
import { useToast } from "@/components/Toast";
import { PumpConfigNotice } from "@/features/pump/components/PumpStates";

type CreateStage = "idle" | "switching" | "hashing" | "approving" | "reserving" | "uploading" | "creating" | "confirming";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const UTF8_ENCODER = new TextEncoder();

export function CreateTokenForm() {
  const router = useRouter();
  const toast = useToast();
  const { address, isConnected, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: PUMP_CHAIN_ID });
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { upload, isUploading } = useIpfsUpload();
  const [stage, setStage] = useState<CreateStage>("idle");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const { data: createFee } = useReadContract({
    chainId: PUMP_CHAIN_ID,
    address: PUMP_FACTORY_ADDRESS,
    abi: zeroXPumpAbi,
    functionName: "createFee",
    query: { enabled: PUMP_CONFIGURED },
  });
  const fee = createFee ?? PUMP_CREATE_FEE;

  const busy = stage !== "idle" || isUploading;
  const validation = useMemo(() => {
    if (!name.trim()) return "Enter a token name";
    if (UTF8_ENCODER.encode(name.trim()).byteLength > 64) return "Token name must be 64 UTF-8 bytes or shorter";
    if (!/^[A-Z0-9]{2,12}$/.test(symbol.trim().toUpperCase())) return "Use 2 to 12 letters or numbers for the ticker";
    if (!description.trim()) return "Describe the token";
    if (description.length > 500) return "Description is too long";
    if (!validOptionalUrl(website)) return "Website must be an HTTPS URL up to 256 characters";
    if (!validOptionalUrl(twitter)) return "Social link must be an HTTPS URL up to 256 characters";
    if (!file) return "Choose a PNG, JPEG, or WebP logo";
    if (!IMAGE_TYPES.has(file.type)) return "Logo must be PNG, JPEG, or WebP";
    if (file.size <= 0 || file.size > PUMP_MAX_IMAGE_BYTES) return "Logo must be non-empty and 2 MB or smaller";
    return null;
  }, [description, file, name, symbol, twitter, website]);

  const handleFile = (nextFile: File | undefined) => {
    if (!nextFile) return;
    if (!IMAGE_TYPES.has(nextFile.type)) {
      toast.warning("Unsupported logo", "Use a PNG, JPEG, or WebP file. SVG is not accepted.");
      return;
    }
    if (nextFile.size <= 0 || nextFile.size > PUMP_MAX_IMAGE_BYTES) {
      toast.warning("Logo too large", "Choose a logo no larger than 2 MB.");
      return;
    }
    setFile(nextFile);
  };

  const submit = async () => {
    if (!PUMP_CONFIGURED || !NUSD_CONFIGURED) {
      toast.info("Contracts not configured", "Set the Pump and NUSD deployment addresses first.");
      return;
    }
    if (!isConnected || !address) {
      toast.warning("Connect wallet", "Connect the wallet that will create this token.");
      return;
    }
    if (!publicClient) {
      toast.error("RPC unavailable", "Refresh the page and try again.");
      return;
    }
    if (validation || !file) {
      toast.warning("Form incomplete", validation ?? "Choose a token logo");
      return;
    }
    let contentHash: Hex | undefined;
    let reservationReady = false;
    try {
      if (chainId !== PUMP_CHAIN_ID) {
        setStage("switching");
        await switchChainAsync({ chainId: PUMP_CHAIN_ID });
      }
      setStage("hashing");
      const imageError = await validatePumpImage(file);
      if (imageError) {
        toast.warning("Invalid logo", imageError);
        return;
      }
      contentHash = await computePumpContentHash({
        chainId: PUMP_CHAIN_ID,
        factory: PUMP_FACTORY_ADDRESS,
        owner: address,
        name,
        symbol,
        description,
        website,
        twitter,
        file,
      });
      const readCreatedToken = async (): Promise<Address | null> => {
        if (!contentHash) return null;
        const token = await publicClient.readContract({
          address: PUMP_FACTORY_ADDRESS,
          abi: zeroXPumpAbi,
          functionName: "createdTokenByContentHash",
          args: [address, contentHash],
        });
        return token.toLowerCase() === ZERO_ADDRESS ? null : getAddress(token);
      };
      const routeToCreatedToken = (token: Address, title: string) => {
        toast.success(title, `${symbol.trim().toUpperCase()} already exists at ${token}.`);
        router.push(`/0xpump/token/${token}`);
      };

      const recoveredBeforeReservation = await readCreatedToken();
      if (recoveredBeforeReservation) {
        routeToCreatedToken(recoveredBeforeReservation, "Existing market recovered");
        return;
      }

      const readinessResponse = await fetch("/api/ipfs/upload", { cache: "no-store" });
      const readiness = (await readinessResponse.json().catch(() => ({}))) as {
        configured?: boolean;
        error?: string;
      };
      if (!readinessResponse.ok || !readiness.configured) {
        throw new Error(readiness.error || "IPFS uploads are not available");
      }
      reservationReady = await publicClient.readContract({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "creationReservations",
        args: [address, contentHash],
      });

      if (!reservationReady) {
        const [currentBalance, currentAllowance] = await Promise.all([
          publicClient.readContract({
            address: PUMP_NUSD_ADDRESS,
            abi: nusdAbi,
            functionName: "balanceOf",
            args: [address],
          }),
          publicClient.readContract({
            address: PUMP_NUSD_ADDRESS,
            abi: nusdAbi,
            functionName: "allowance",
            args: [address, PUMP_FACTORY_ADDRESS],
          }),
        ]);
        if (currentBalance < fee) {
          toast.warning("Not enough NUSD", `Reserving a market costs ${formatUnits(fee, 18)} NUSD.`);
          return;
        }
        if (currentAllowance < fee) {
          setStage("approving");
          const approvalHash = await writeContractAsync({
            address: PUMP_NUSD_ADDRESS,
            abi: nusdAbi,
            functionName: "approve",
            args: [PUMP_FACTORY_ADDRESS, maxUint256],
          });
          const approvalReceipt = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
          if (approvalReceipt.status !== "success") throw new Error("NUSD approval reverted");
        }

        const recoveredBeforeFee = await readCreatedToken();
        if (recoveredBeforeFee) {
          routeToCreatedToken(recoveredBeforeFee, "Existing market recovered");
          return;
        }
        reservationReady = await publicClient.readContract({
          address: PUMP_FACTORY_ADDRESS,
          abi: zeroXPumpAbi,
          functionName: "creationReservations",
          args: [address, contentHash],
        });
        if (!reservationReady) {
          setStage("reserving");
          await publicClient.simulateContract({
            account: address,
            address: PUMP_FACTORY_ADDRESS,
            abi: zeroXPumpAbi,
            functionName: "reserveMarket",
            args: [contentHash],
          });
          const reservationHash = await writeContractAsync({
            address: PUMP_FACTORY_ADDRESS,
            abi: zeroXPumpAbi,
            functionName: "reserveMarket",
            args: [contentHash],
          });
          const reservationReceipt = await publicClient.waitForTransactionReceipt({ hash: reservationHash });
          if (reservationReceipt.status !== "success") throw new Error("Creation reservation reverted");
          reservationReady = true;
        }
      }

      const recoveredBeforeUpload = await readCreatedToken();
      if (recoveredBeforeUpload) {
        routeToCreatedToken(recoveredBeforeUpload, "Existing market recovered");
        return;
      }

      setStage("uploading");
      const metadata = await upload({
        file,
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        description: description.trim(),
        website: website.trim(),
        twitter: twitter.trim(),
      }, contentHash);

      const recoveredBeforeCreate = await readCreatedToken();
      if (recoveredBeforeCreate) {
        routeToCreatedToken(recoveredBeforeCreate, "Existing market recovered");
        return;
      }

      setStage("creating");
      await publicClient.simulateContract({
        account: address,
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "createMarket",
        args: [name.trim(), symbol.trim().toUpperCase(), metadata.metadataURI, metadata.imageURI, contentHash],
      });
      const hash = await writeContractAsync({
        address: PUMP_FACTORY_ADDRESS,
        abi: zeroXPumpAbi,
        functionName: "createMarket",
        args: [name.trim(), symbol.trim().toUpperCase(), metadata.metadataURI, metadata.imageURI, contentHash],
      });
      setStage("confirming");
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("Market creation reverted");

      let token: Address | null = null;
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== PUMP_FACTORY_ADDRESS.toLowerCase()) continue;
        try {
          const decoded = decodeEventLog({ abi: zeroXPumpAbi, data: log.data, topics: log.topics });
          if (decoded.eventName === "TokenCreated") {
            token = getAddress((decoded.args as { token: Address }).token);
            break;
          }
        } catch {
          // Ignore logs from other contracts in the transaction.
        }
      }
      toast.success("Token market created", `${symbol.trim().toUpperCase()} is live on 0xPump.`);
      router.push(token ? `/0xpump/token/${token}` : "/0xpump");
    } catch (error) {
      if (contentHash) {
        try {
          const recoveredToken = await publicClient.readContract({
            address: PUMP_FACTORY_ADDRESS,
            abi: zeroXPumpAbi,
            functionName: "createdTokenByContentHash",
            args: [address, contentHash],
          });
          if (recoveredToken.toLowerCase() !== ZERO_ADDRESS) {
            const token = getAddress(recoveredToken);
            toast.success("Market transaction recovered", `${symbol.trim().toUpperCase()} is live at ${token}.`);
            router.push(`/0xpump/token/${token}`);
            return;
          }
        } catch {
          // Surface the original transaction error if recovery RPC is unavailable.
        }
      }
      toast.handleError(error, "Could not create token");
      if (reservationReady && contentHash) {
        toast.info("Creation fee remains reserved", "Retry with the same form fields and logo to continue without paying again.");
      }
    } finally {
      setStage("idle");
    }
  };

  const buttonLabel =
    stage === "switching" ? "Switching network" :
    stage === "hashing" ? "Preparing content" :
    stage === "approving" ? "Approving NUSD" :
    stage === "reserving" ? "Reserving market" :
    stage === "uploading" || isUploading ? "Uploading to IPFS" :
    stage === "creating" ? "Submitting market" :
    stage === "confirming" ? "Confirming market" :
    "Create token market";

  return (
    <div className="pump-create-grid">
      <section className="pump-panel pump-create-form">
        <div className="pump-panel-heading">
          <div><span className="pump-eyebrow">Token details</span><h2>Create a market</h2></div>
          <span className="pump-fee-chip">Fee {formatUnits(fee, 18)} NUSD</span>
        </div>

        {!PUMP_CONFIGURED || !NUSD_CONFIGURED ? <PumpConfigNotice compact /> : null}

        <div className="pump-form-grid">
          <label className="pump-field pump-field-wide">
            <span>Logo</span>
            <span className="pump-logo-drop">
              <span className="pump-logo-preview">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="Token logo preview" />
                ) : <span>IMG</span>}
              </span>
              <span><strong>{file?.name || "Choose token logo"}</strong><small>PNG, JPEG or WebP. Maximum 2 MB.</small></span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => handleFile(event.target.files?.[0])}
              />
            </span>
          </label>

          <label className="pump-field"><span>Name</span><input value={name} maxLength={64} onChange={(event) => setName(event.target.value)} placeholder="Nothing Coin" /></label>
          <label className="pump-field"><span>Ticker</span><input value={symbol} maxLength={12} onChange={(event) => setSymbol(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))} placeholder="NOTHING" /></label>
          <label className="pump-field pump-field-wide"><span>Description</span><textarea value={description} maxLength={500} rows={5} onChange={(event) => setDescription(event.target.value)} placeholder="What is this token about?" /><small>{description.length}/500</small></label>
          <label className="pump-field"><span>Website <em>optional</em></span><input type="url" value={website} onChange={(event) => setWebsite(event.target.value)} placeholder="https://" /></label>
          <label className="pump-field"><span>Social <em>optional</em></span><input type="url" value={twitter} onChange={(event) => setTwitter(event.target.value)} placeholder="https://x.com/" /></label>
        </div>

        {validation ? <p className="pump-form-hint">{validation}</p> : null}
        <button
          className="pump-button pump-button-primary pump-button-large pump-button-full"
          type="button"
          disabled={busy || !PUMP_CONFIGURED || !NUSD_CONFIGURED}
          onClick={() => void submit()}
        >
          {buttonLabel}
        </button>
      </section>

    </div>
  );
}

function validOptionalUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "https:" && trimmed.length <= 256;
  } catch {
    return false;
  }
}
