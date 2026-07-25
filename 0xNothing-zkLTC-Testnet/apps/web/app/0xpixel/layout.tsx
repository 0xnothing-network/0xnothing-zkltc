import { PixelHeader } from "@/components/PixelHeader";

export default function PixelLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <PixelHeader />
      {children}
    </>
  );
}
