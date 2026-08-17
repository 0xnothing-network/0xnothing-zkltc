import { PixelHeader } from "@/features/pixel/components/PixelHeader";
import { Providers } from "@/app/providers";

export default function PixelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Providers>
      <PixelHeader />
      {children}
    </Providers>
  );
}
