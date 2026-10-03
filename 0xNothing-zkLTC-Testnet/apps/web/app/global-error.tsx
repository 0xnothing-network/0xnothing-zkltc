"use client";

import { RecoveryPanel } from "@/components/RecoveryPanel";
import "./globals.css";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body>
        <RecoveryPanel reset={reset} digest={error.digest} />
      </body>
    </html>
  );
}
