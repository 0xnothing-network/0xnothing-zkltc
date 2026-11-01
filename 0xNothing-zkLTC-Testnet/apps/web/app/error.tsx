"use client";

import { RecoveryPanel } from "@/components/RecoveryPanel";

export default function ErrorPage({ error }: { error: Error & { digest?: string } }) {
  return <RecoveryPanel digest={error.digest} />;
}
