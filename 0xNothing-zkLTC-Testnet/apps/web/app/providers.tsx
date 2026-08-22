"use client";

import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useBlockNumber } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi";
import { ToastProvider } from "@/components/Toast";
import { BLOCK_SYNC_MS, isBlockSyncedQueryKey } from "@/lib/liveData";

const BLOCK_POLL_MS = BLOCK_SYNC_MS + Math.floor(Math.random() * 2_001);

function LiveSync() {
  const queryClient = useQueryClient();
  const lastBlockRef = useRef<bigint | undefined>(undefined);
  const blockNumber = useBlockNumber({
    query: {
      refetchInterval: BLOCK_POLL_MS,
      refetchIntervalInBackground: false,
      staleTime: 0,
    },
  });

  useEffect(() => {
    if (blockNumber.data === undefined) return;
    if (lastBlockRef.current === undefined) {
      lastBlockRef.current = blockNumber.data;
      return;
    }
    if (lastBlockRef.current === blockNumber.data) return;
    lastBlockRef.current = blockNumber.data;
    void queryClient.invalidateQueries({
      predicate: (query) => query.getObserversCount() > 0
        && query.state.fetchStatus !== "fetching"
        && isBlockSyncedQueryKey(query.queryKey),
      refetchType: "active",
    });
  }, [blockNumber.data, queryClient]);

  return null;
}

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
