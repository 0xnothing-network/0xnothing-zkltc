import type { Metadata } from "next";
import { PixelHeader } from "@/features/pixel/components/PixelHeader";
import { Providers } from "@/app/providers";
import "./globals.css";
import "./product.css";
import "./pixel-skin.css";

export const metadata: Metadata = {
  title: { default: "0xPixel | Draw and mint pixel art", template: "%s | 0xPixel" },
};

export default function PixelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <div className="pixel-product">
        <PixelHeader />
        {children}
      </div>
    </Providers>
  );
}
