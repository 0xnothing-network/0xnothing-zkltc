"use client";

import { ErrorState } from "@/components/UiStates";

export default function ErrorPage({ error, reset }: { error: Error; reset: () => void }) {
  return <div className="fi-page"><ErrorState message={error.message} onRetry={reset} /></div>;
}
