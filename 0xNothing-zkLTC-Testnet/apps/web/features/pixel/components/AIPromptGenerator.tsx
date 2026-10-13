"use client";

import { memo, useState, useEffect, useMemo, useRef } from "react";

interface AIPromptGeneratorProps {
  gridSize: number;
  onApplyPixelData?: (pixelData: string[][]) => void;
}

const GRID_ENTRY_SOURCE = String.raw`\[(\d+),(\d+)\]\s*=\s*(#[0-9A-Fa-f]{6})`;

export const AIPromptGenerator = memo(function AIPromptGenerator({ gridSize, onApplyPixelData }: AIPromptGeneratorProps) {
  const [generated, setGenerated] = useState("");
  const [parsed, setParsed] = useState(false);
  const parsedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (parsedTimerRef.current) clearTimeout(parsedTimerRef.current);
    };
  }, []);

  const parseGridData = (text: string): string[][] => {
    const newPixelData: string[][] = Array(gridSize).fill(null).map(() =>
      Array(gridSize).fill("transparent")
    );

    // A fresh RegExp per parse: a shared `/g` literal carries `lastIndex`
    // between calls, which would make the second parse start mid-input.
    const pattern = new RegExp(GRID_ENTRY_SOURCE, "g");
    let match;

    while ((match = pattern.exec(text)) !== null) {
      const x = parseInt(match[1]);
      const y = parseInt(match[2]);
      const color = match[3].toUpperCase();

      if (x >= 0 && x < gridSize && y >= 0 && y < gridSize) {
        newPixelData[y][x] = color;
      }
    }

    return newPixelData;
  };

  const handleParse = () => {
    if (!generated.trim()) return;

    const pixelData = parseGridData(generated);
    if (onApplyPixelData) {
      onApplyPixelData(pixelData);
      setParsed(true);
      if (parsedTimerRef.current) clearTimeout(parsedTimerRef.current);
      parsedTimerRef.current = setTimeout(() => {
        parsedTimerRef.current = null;
        setParsed(false);
      }, 2000);
    }
  };

  // Pasted grid data can run to thousands of entries; scanning it on every
  // keystroke of the textarea is wasted work once the text stops changing.
  const count = useMemo(
    () => (generated.match(new RegExp(GRID_ENTRY_SOURCE, "g")) || []).length,
    [generated],
  );

  return (
    <div className="pixel-generator-panel bg-(--surface-1) rounded-2xl p-3 sm:p-5 border border-(--line)">
      <div className="flex items-center gap-2 mb-3">
        <svg width="18" height="18" fill="none" stroke="#6366F1" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
          <path d="M12 6v6l4 2" />
        </svg>
        <h3 className="text-(--text-1) font-bold text-sm" style={{ fontFamily: "var(--font-ui)" }}>
          Grid Data Parser
        </h3>
      </div>

      <textarea
        value={generated}
        onChange={(e) => setGenerated(e.target.value)}
        placeholder="[0,0]=#FF0000&#10;[1,0]=#00FF00"
        className="w-full px-3 py-3 sm:py-2.5 rounded-xl bg-(--surface-2) text-(--text-1) placeholder-(--text-3) focus:outline-none focus:border-(--accent) resize-none font-mono text-xs leading-relaxed border border-(--line) transition-all"
        rows={4}
      />

      {count > 0 && (
        <p className="text-(--text-3) text-xs mt-2 mb-2" style={{ fontFamily: "var(--font-ui)" }}>
          {count} pixel{count !== 1 ? "s" : ""} detected
        </p>
      )}

      <button
        onClick={handleParse}
        className={
          "w-full py-3 sm:py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all mt-2 " +
          (parsed
            ? "bg-(--positive) text-(--text-1)"
            : "bg-(--surface-2) border border-(--line) text-(--text-3) hover:bg-(--surface-3) hover:text-(--text-1)")
        }
        style={{ fontFamily: "var(--font-ui)" }}
      >
        {parsed ? "APPLIED!" : "Apply to Canvas"}
      </button>
    </div>
  );
});
