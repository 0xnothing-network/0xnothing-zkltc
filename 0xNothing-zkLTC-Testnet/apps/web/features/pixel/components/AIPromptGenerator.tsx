"use client";

import { memo, useState, useEffect, useRef } from "react";

interface AIPromptGeneratorProps {
  gridSize: number;
  onApplyPixelData?: (pixelData: string[][]) => void;
}

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

    const pattern = /\[(\d+),(\d+)\]\s*=\s*(#[0-9A-Fa-f]{6})/g;
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

  const count = (generated.match(/\[(\d+),(\d+)\]\s*=\s*(#[0-9A-Fa-f]{6})/g) || []).length;

  return (
    <div className="bg-[#1A1A2E] rounded-2xl p-3 sm:p-5 border border-[#2D2D44]">
      <div className="flex items-center gap-2 mb-3">
        <svg width="18" height="18" fill="none" stroke="#6366F1" strokeWidth="2" viewBox="0 0 24 24">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2z" />
          <path d="M12 6v6l4 2" />
        </svg>
        <h3 className="text-white font-bold text-sm" style={{ fontFamily: "var(--font-departure)" }}>
          Grid Data Parser
        </h3>
      </div>

      <textarea
        value={generated}
        onChange={(e) => setGenerated(e.target.value)}
        placeholder="[0,0]=#FF0000&#10;[1,0]=#00FF00"
        className="w-full px-3 py-3 sm:py-2.5 rounded-xl bg-[#0F0F23] text-white placeholder-[#374151] focus:outline-none focus:border-indigo-500 resize-none font-mono text-[11px] leading-relaxed border border-[#2D2D44] transition-all"
        rows={4}
      />

      {count > 0 && (
        <p className="text-[#64748B] text-xs mt-2 mb-2" style={{ fontFamily: "var(--font-departure)" }}>
          {count} pixel{count !== 1 ? "s" : ""} detected
        </p>
      )}

      <button
        onClick={handleParse}
        className={
          "w-full py-3 sm:py-2.5 rounded-xl font-bold text-xs uppercase tracking-wider transition-all mt-2 " +
          (parsed
            ? "bg-emerald-500 text-white"
            : "bg-[#0F0F23] border border-[#2D2D44] text-[#64748B] hover:bg-[#252540] hover:text-white")
        }
        style={{ fontFamily: "var(--font-departure)" }}
      >
        {parsed ? "APPLIED!" : "Apply to Canvas"}
      </button>
    </div>
  );
});
