import type { Metadata } from "next";
import { Providers } from "@/app/providers";
import { ToastProvider } from "@fi/components/Toast";

export const metadata: Metadata = {
  title: "Developer Console | 0xNothing",
  description: "Testnet operator console for 0xNothing protocol contracts.",
  robots: { index: false, follow: false },
};

export default function DevLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <Providers withToast={false}><ToastProvider>{children}</ToastProvider></Providers>;
}
