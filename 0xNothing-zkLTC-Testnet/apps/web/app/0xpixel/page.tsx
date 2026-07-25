"use client";

import { useState, useEffect, useCallback, useDeferredValue, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Toolbar } from "@/components/Toolbar";
import { AIPromptGenerator } from "@/components/AIPromptGenerator";
import { PixelLoadingIndicator } from "@/components/PageLoader";

const MAX_HISTORY = 50;
const DEFAULT_GRID_SIZE = 16;

function makeEmptyGrid(gridSize: number): string[][] {
  return Array.from({ length: gridSize }, () =>
    Array.from({ length: gridSize }, () => "transparent")
  );
}

const Canvas = dynamic(
  () => import("@/components/Canvas").then((m) => m.Canvas),
  { ssr: false, loading: () => <CanvasSkeleton /> }
);
const MintPanel = dynamic(
  () => import("@/components/MintPanel").then((m) => m.MintPanel),
  { ssr: false, loading: () => <PanelSkeleton label="Mint" /> }
);
function PanelSkeleton({ label }: { label: string }) {
  return (
    <div className="pixel-panel flex h-32 items-center justify-center p-4" role="status" aria-label={`${label} loading`}>
      <PixelLoadingIndicator compact />
    </div>
  );
}

function CanvasSkeleton() {
  return (
    <div
      className="pixel-canvas-skeleton flex aspect-square w-full max-w-[640px] items-center justify-center border border-[#2D2D44]"
      role="status"
      aria-label="Canvas loading"
    >
      <PixelLoadingIndicator compact />
    </div>
  );
}

export default function PixelPage() {
  const [gridSize, setGridSize] = useState(DEFAULT_GRID_SIZE);
  const [pixelData, setPixelData] = useState<string[][]>(() =>
    makeEmptyGrid(DEFAULT_GRID_SIZE)
  );
  const [history, setHistory] = useState<string[][][]>([]);
  const [selectedColor, setSelectedColor] = useState("#6366F1");
  const deferredPixelData = useDeferredValue(pixelData);

  const pixelDataRef = useRef(pixelData);
  const historyRef = useRef(history);

  useEffect(() => { pixelDataRef.current = pixelData; }, [pixelData]);
  useEffect(() => { historyRef.current = history; }, [history]);

  const pushHistory = useCallback((snapshot: string[][]) => {
    setHistory((h) => [...h, snapshot.map((row) => [...row])].slice(-MAX_HISTORY));
  }, []);

  const handleClear = useCallback(() => {
    pushHistory(pixelDataRef.current);
    setPixelData(makeEmptyGrid(gridSize));
  }, [gridSize, pushHistory]);

  const handleApplyPixelData = useCallback(
    (newPixelData: string[][]) => {
      pushHistory(pixelDataRef.current);
      setPixelData(newPixelData);
    },
    [pushHistory]
  );

  const handleStrokeStart = useCallback(() => {
    pushHistory(pixelDataRef.current);
  }, [pushHistory]);

  const handleUndo = useCallback(() => {
    if (historyRef.current.length === 0) return;
    const prev = historyRef.current[historyRef.current.length - 1];
    setHistory((h) => h.slice(0, -1));
    setPixelData(prev);
  }, []);

  const canUndo = history.length > 0;

  const setSelectedColorStable = useCallback((c: string) => setSelectedColor(c), []);
  const setGridSizeStable = useCallback((size: number) => {
    if (size === gridSize) return;
    setGridSize(size);
    setPixelData(makeEmptyGrid(size));
    setHistory([]);
  }, [gridSize]);
  const handleMintSuccess = useCallback(() => {}, []);

  return (
    <div style={{ fontFamily: "var(--font-departure)" }}>
      <section className="relative overflow-hidden border-b border-white/5">
        <div className="max-w-7xl mx-auto px-4 pt-7 pb-6 text-center relative sm:px-5 sm:pt-12 sm:pb-10">
          <h1
            className="text-2xl sm:text-3xl md:text-5xl font-bold text-white mb-3 sm:mb-4 tracking-tight leading-tight hero-fade-in text-balance"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            Create your{" "}
            <span className="text-white/70">
              pixel masterpiece
            </span>
          </h1>
          <p
            className="text-[#94A3B8] text-sm sm:text-base md:text-lg max-w-md mx-auto hero-fade-in-delay"
            style={{ fontFamily: "var(--font-departure)" }}
          >
            Draw. Mint. Trade on LitVM.
          </p>
        </div>
      </section>

      <main className="max-w-7xl mx-auto px-3 pt-4 pb-24 sm:px-5 sm:pt-8 sm:pb-16">
        <div className="grid xl:grid-cols-[300px_minmax(0,1fr)_380px] gap-4 sm:gap-6 items-start">
          <div className="order-2 xl:order-1">
            <div className="xl:sticky xl:top-20">
              <Toolbar
                selectedColor={selectedColor}
                onColorChange={setSelectedColorStable}
                gridSize={gridSize}
                onGridSizeChange={setGridSizeStable}
                onClear={handleClear}
              />
            </div>
          </div>

          <div className="order-1 xl:order-2 flex min-w-0 justify-center">
            <Canvas
              gridSize={gridSize}
              pixelData={pixelData}
              setPixelData={setPixelData}
              selectedColor={selectedColor}
              onColorPick={setSelectedColorStable}
              onStrokeStart={handleStrokeStart}
              onUndo={handleUndo}
              canUndo={canUndo}
            />
          </div>

          <div className="order-3 space-y-4">
            <MintPanel
              pixelData={deferredPixelData}
              gridSize={gridSize}
              isCanvasUpdating={deferredPixelData !== pixelData}
              onMintSuccess={handleMintSuccess}
            />
            <AIPromptGenerator
              gridSize={gridSize}
              onApplyPixelData={handleApplyPixelData}
            />
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="border-t border-white/5 py-5 mt-8">
      <div className="max-w-7xl mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-2">
        <Link
          href="/"
          className="flex items-center gap-2 text-[#64748B] text-xs hover:text-white transition-colors"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/0xNothing.jpg"
            alt="0xNothing"
            loading="lazy"
            width={20}
            height={20}
            className="w-5 h-5 rounded-full object-cover"
          />
          <span>by 0xNothing</span>
        </Link>
        <p
          className="text-[#374151] text-xs"
          style={{ fontFamily: "var(--font-departure)" }}
        >
          Built on LitVM
        </p>
      </div>
    </footer>
  );
}
