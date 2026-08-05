"use client";

import { useCallback, useState } from "react";
import { getAccount } from "wagmi/actions";
import { useSignMessage } from "wagmi";
import type { Hex } from "viem";
import { PUMP_CHAIN_ID } from "@/features/pump/config";
import { buildPumpUploadMessage } from "@/features/pump/uploadMessage";
import { wagmiConfig } from "@/lib/wagmi";

export interface PumpMetadataInput {
  file: File;
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
}

export interface PumpUploadResult {
  imageCid: string;
  imageURI: string;
  metadataCid: string;
  metadataURI: string;
}

export function useIpfsUpload() {
  const { signMessageAsync } = useSignMessage();
  const [isUploading, setUploading] = useState(false);

  const upload = useCallback(
    async (input: PumpMetadataInput, contentHash: Hex): Promise<PumpUploadResult> => {
      const { address, chainId } = getAccount(wagmiConfig);
      if (!address) throw new Error("Connect a wallet before uploading a token logo");
      if (chainId !== PUMP_CHAIN_ID) throw new Error("Switch to LitVM before uploading");

      const timestamp = new Date().toISOString();
      const nonce = crypto.randomUUID().replace(/-/g, "");
      const message = buildPumpUploadMessage({
        address,
        chainId: PUMP_CHAIN_ID,
        domain: window.location.host,
        contentHash,
        nonce,
        timestamp,
      });

      setUploading(true);
      try {
        const signature = await signMessageAsync({ message });
        const form = new FormData();
        form.set("file", input.file);
        form.set("address", address);
        form.set("message", message);
        form.set("signature", signature);
        form.set("contentHash", contentHash);
        form.set("name", input.name);
        form.set("symbol", input.symbol);
        form.set("description", input.description);
        form.set("website", input.website ?? "");
        form.set("twitter", input.twitter ?? "");

        const response = await fetch("/api/ipfs/upload", {
          method: "POST",
          body: form,
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as
          | PumpUploadResult
          | { error?: string };
        if (!response.ok || !("metadataURI" in body)) {
          throw new Error("error" in body && body.error ? body.error : "IPFS upload failed");
        }
        return body;
      } finally {
        setUploading(false);
      }
    },
    [signMessageAsync],
  );

  return { upload, isUploading };
}
