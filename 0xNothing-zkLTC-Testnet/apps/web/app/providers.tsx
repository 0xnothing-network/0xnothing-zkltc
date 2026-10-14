"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { ToastProvider } from "@/components/Toast";
import { LiveSync } from "@/components/LiveSync";

export function Providers({
  children,
  withToast = true,
}: {
  children: React.ReactNode;
  withToast?: boolean;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 1000,
            gcTime: 10 * 60 * 1000,
            retry: 1,
            retryDelay: (attemptIndex) => Math.min(500 * 2 ** attemptIndex, 3000),
            refetchOnWindowFocus: true,
            refetchOnReconnect: true,
          },
          mutations: {
            retry: 0,
          },
        },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <LiveSync />
        {withToast ? <ToastProvider>{children}</ToastProvider> : children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
