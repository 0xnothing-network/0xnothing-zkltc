import { AppShell } from "@/components/shell/AppShell";
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
      <div className="pixel-product" data-product="pixel">
        <AppShell product="pixel">{children}</AppShell>
      </div>
    </Providers>
  );
}
