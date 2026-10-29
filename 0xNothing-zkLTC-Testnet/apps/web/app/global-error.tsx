"use client";

import { RecoveryPanel } from "@/components/RecoveryPanel";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
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
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <RecoveryPanel reset={reset} digest={error.digest} />
      </body>
    </html>
  );
}
