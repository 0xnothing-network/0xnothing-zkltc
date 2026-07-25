import type { Metadata } from "next";
import { getAddress, isAddress } from "viem";
import { notFound } from "next/navigation";
import { TokenDetail } from "@/features/pump/components/TokenDetail";

export const metadata: Metadata = {
  title: "Token market | 0xPump",
  description: "Live NUSD bonding-curve market on 0xPump.",
};

export default async function PumpTokenPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isAddress(token)) notFound();
  return <TokenDetail token={getAddress(token)} />;
}
