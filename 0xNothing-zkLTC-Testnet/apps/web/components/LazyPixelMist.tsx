"use client";

import dynamic from "next/dynamic";

export const LazyPixelMist = dynamic(
  () => import("@/components/PixelMist").then((module) => module.PixelMist),
  { ssr: false },
);
