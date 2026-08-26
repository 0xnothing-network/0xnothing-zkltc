"use client";

import { Check, Copy, Warning } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

type CopyState = "idle" | "copied" | "error";

export function DocsCodeBlock({
  code,
  label,
  language = "typescript",
}: {
  code: string;
  label: string;
  language?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => {
    if (resetTimer.current) clearTimeout(resetTimer.current);
  }, []);

  async function copyCode() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(code);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    resetTimer.current = setTimeout(() => setCopyState("idle"), 2_000);
  }

  const CopyIcon = copyState === "copied" ? Check : copyState === "error" ? Warning : Copy;
  const copyLabel = copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy";

  return (
    <figure className="ox-docs-code">
      <figcaption>
        <span className="ox-docs-code-label">{label}</span>
        <span className="ox-docs-code-language">{language}</span>
        <button type="button" onClick={() => void copyCode()} aria-label={`Copy ${label}`}>
          <CopyIcon size={14} weight="bold" aria-hidden="true" />
          <span aria-live="polite">{copyLabel}</span>
        </button>
      </figcaption>
      <pre tabIndex={0}><code>{code}</code></pre>
    </figure>
  );
}
