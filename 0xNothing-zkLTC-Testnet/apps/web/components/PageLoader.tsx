const LOADER_BLOCKS = Array.from({ length: 12 });
const COMPACT_LOADER_BLOCKS = Array.from({ length: 8 });

export function PixelLoadingIndicator({ compact = false }: { compact?: boolean }) {
  const blocks = compact ? COMPACT_LOADER_BLOCKS : LOADER_BLOCKS;
  return (
    <div className={compact ? "pixel-loader-track pixel-loader-track-compact" : "pixel-loader-track"} aria-hidden="true">
      {blocks.map((_, index) => (
        <span key={index} style={{ animationDelay: `${index * 55}ms` }} />
      ))}
    </div>
  );
}

export function PageLoader({ embedded = false, label = "Loading workspace" }: { embedded?: boolean; label?: string }) {
  return (
    <div className={`pixel-shell pixel-page-loader flex flex-col items-center justify-center ${embedded ? "min-h-[calc(100dvh-64px)]" : "min-h-[100dvh]"}`} role="status" aria-live="polite">
      <div className="pixel-loader-card">
        <div className="pixel-loader-logo" aria-hidden="true">N</div>
        <span className="pixel-loader-brand" aria-hidden="true">0xNothing</span>
        <PixelLoadingIndicator />
        <span className="pixel-loader-label">{label}</span>
      </div>
    </div>
  );
}
