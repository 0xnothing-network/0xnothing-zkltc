"use client";

import { RecoveryPanel } from "@/components/RecoveryPanel";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <RecoveryPanel reset={reset} digest={error.digest} />;
}
