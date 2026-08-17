import { PixelLoadingIndicator } from "@/components/PageLoader";

function NFTCardSkeleton() {
  return (
    <div className="pixel-panel overflow-hidden">
      <div className="flex aspect-square items-center justify-center border-b border-white/[0.08] bg-[#07070d] p-4">
        <div className="h-20 w-20 pixel-skeleton-surface" aria-hidden="true" />
      </div>
      <div className="p-4 space-y-3">
        <div className="h-4 w-3/4 pixel-skeleton-surface" />
        <div className="h-3 w-1/2 pixel-skeleton-surface" />
        <div className="h-3 w-full pixel-skeleton-surface" />
        <div className="space-y-2 border-t border-white/[0.08] pt-2">
          <div className="h-9 pixel-skeleton-surface" />
        </div>
      </div>
    </div>
  );
}

export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="pixel-grid-loading" role="status" aria-label="Loading items" style={{ fontFamily: "var(--font-departure)" }}>
      <div className="pixel-grid-loading-marker"><PixelLoadingIndicator compact /></div>
      <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 sm:gap-6" aria-hidden="true">
        {Array.from({ length: count }).map((_, i) => (
          <NFTCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
