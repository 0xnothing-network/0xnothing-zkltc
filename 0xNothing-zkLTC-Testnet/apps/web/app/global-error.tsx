"use client";

import { RecoveryPanel } from "@/components/RecoveryPanel";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import "./globals.css";

export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en" className="dark">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <RecoveryPanel digest={error.digest} />
      </body>
    </html>
  );
}
