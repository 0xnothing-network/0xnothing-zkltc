import { PixelHeader } from "@/features/pixel/components/PixelHeader";
import { Providers } from "@/app/providers";
import "./globals.css";
import "./product.css";

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
