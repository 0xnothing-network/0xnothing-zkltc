"use client";

import { useState, useEffect, useCallback, useDeferredValue, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Toolbar } from "@/features/pixel/components/Toolbar";
import { AIPromptGenerator } from "@/features/pixel/components/AIPromptGenerator";
import { PixelLoadingIndicator } from "@/components/PageLoader";

const MAX_HISTORY = 50;
const DEFAULT_GRID_SIZE = 16;

function makeEmptyGrid(gridSize: number): string[][] {
  return Array.from({ length: gridSize }, () =>
    Array.from({ length: gridSize }, () => "transparent")
  );
}

const Canvas = dynamic(
  () => import("@/features/pixel/components/Canvas").then((m) => m.Canvas),
  { ssr: false, loading: () => <CanvasSkeleton /> }
);
const MintPanel = dynamic(
  () => import("@/features/pixel/components/MintPanel").then((m) => m.MintPanel),
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

  // `historyRef` is the undo stack; `history` only mirrors it so `canUndo` has
  // something to render from. The ref is written before the state deliberately:
  // Ctrl+Z is bound to a window keydown with no repeat guard, so holding it
  // fires at the OS key-repeat rate — far faster than a passive effect can copy
  // state back into a ref. While the ref lagged, every repeat past the first
  // popped a fresh entry off the stack but restored the same stale snapshot, so
  // holding undo quietly ate the history while the canvas moved back one step.
  const pushHistory = useCallback((snapshot: string[][]) => {
    historyRef.current = [
      ...historyRef.current,
      snapshot.map((row) => [...row]),
    ].slice(-MAX_HISTORY);
    setHistory(historyRef.current);
  }, []);

  const handleClear = useCallback(() => {
    const cleared = makeEmptyGrid(gridSize);
    pushHistory(pixelDataRef.current);
    pixelDataRef.current = cleared;
    setPixelData(cleared);
  }, [gridSize, pushHistory]);

  const handleApplyPixelData = useCallback(
    (newPixelData: string[][]) => {
      pushHistory(pixelDataRef.current);
      pixelDataRef.current = newPixelData;
      setPixelData(newPixelData);
    },
    [pushHistory]
  );

  // Canvas already keeps its own copy of the grid synchronously current and
  // hands it over, so snapshot what it passes rather than this component's
  // effect-fed mirror — that mirror still holds the grid from before the
  // previous stroke whenever two strokes land inside a single commit.
  const handleStrokeStart = useCallback((dataBeforeStroke: string[][]) => {
    pushHistory(dataBeforeStroke);
  }, [pushHistory]);

  const handleUndo = useCallback(() => {
    const stack = historyRef.current;
    if (stack.length === 0) return;
    const previous = stack[stack.length - 1];
    historyRef.current = stack.slice(0, -1);
    setHistory(historyRef.current);
    pixelDataRef.current = previous;
    setPixelData(previous);
  }, []);

  const canUndo = history.length > 0;

  const setSelectedColorStable = useCallback((c: string) => setSelectedColor(c), []);
  const setGridSizeStable = useCallback((size: number) => {
    if (size === gridSize) return;
    const empty = makeEmptyGrid(size);
    setGridSize(size);
    pixelDataRef.current = empty;
    setPixelData(empty);
    historyRef.current = [];
    setHistory(historyRef.current);
  }, [gridSize]);
  const handleMintSuccess = useCallback(() => {}, []);

  return (
    <div style={{ fontFamily: "var(--font-departure)" }}>
      <section className="pixel-studio-intro relative overflow-hidden border-b border-white/5">
        <div className="pixel-studio-intro-inner max-w-7xl mx-auto px-4 pt-7 pb-6 relative sm:px-5 sm:pt-12 sm:pb-10">
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

      <main className="pixel-workspace max-w-7xl mx-auto px-3 pt-4 pb-24 sm:px-5 sm:pt-8 sm:pb-16">
        <div className="pixel-workspace-grid grid gap-4 sm:gap-6 items-start">
          <div className="pixel-tools-column order-2 xl:order-1">
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

          <div className="pixel-drawing-column order-1 xl:order-2 flex min-w-0 justify-center">
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

          <div className="pixel-publish-column order-3 space-y-4">
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
