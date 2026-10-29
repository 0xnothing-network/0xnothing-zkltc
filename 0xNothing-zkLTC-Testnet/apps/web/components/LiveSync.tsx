"use client";

import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useBlockNumber } from "wagmi";
import { litvm } from "@/config/wagmi";
import { BLOCK_SYNC_MS, isBlockSyncedQueryKey, isLiveQueryKey, notifyLiveWave, setLiveSocketConnected } from "@/lib/liveData";
import { createWaveScheduler, liveWatchAddresses, oncePerBlock, startLiveSocket, type LiveSocketSession } from "@/lib/liveEvents";
import { LITVM_WS_URLS } from "@/lib/publicConfig";

const BLOCK_POLL_MS = BLOCK_SYNC_MS + Math.floor(Math.random() * 2_001);
/** With events pushed over the socket, the block sweep only refreshes time-dependent reads. */
const SOCKET_SWEEP_MS = 30_000 + Math.floor(Math.random() * 5_001);
const WAVE_MIN_GAP_MS = 1_500;
const WAVE_FOLLOW_UP_MS = 2_500;
const FILTER_DEBOUNCE_MS = 1_000;

/**
 * Keeps every mounted view current without a page reload. Chain events from the
 * protocol contracts, from whatever contract a view reads, and token transfers
 * to or from the connected wallet arrive over a WebSocket and refresh the live
 * queries at once. A periodic block sweep remains for values that move with time
 * alone, and is the whole mechanism while the socket is down.
 */
export function LiveSync() {
  const queryClient = useQueryClient();
  const { address } = useAccount();
  const [socketLive, setSocketLive] = useState(false);
  const sessionRef = useRef<LiveSocketSession | undefined>(undefined);
  const accountRef = useRef(address);
  const lastBlockRef = useRef<bigint | undefined>(undefined);
  const blockNumber = useBlockNumber({
    chainId: litvm.id,
    query: {
      refetchInterval: socketLive ? SOCKET_SWEEP_MS : BLOCK_POLL_MS,
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

  useEffect(() => {
    const cache = queryClient.getQueryCache();
    let missedWave = false;
    const waves = createWaveScheduler(() => {
      // "active" refetches mounted queries even in a background tab, so a hidden
      // page only remembers that it is behind and catches up once when shown.
      if (document.visibilityState === "hidden") {
        missedWave = true;
        return;
      }
      // In-flight reads finish; the follow-up wave picks up anything they missed.
      void queryClient.invalidateQueries(
        { predicate: (query) => isLiveQueryKey(query.queryKey), refetchType: "active" },
        { cancelRefetch: false },
      );
      notifyLiveWave();
    }, { minGapMs: WAVE_MIN_GAP_MS, followUpMs: WAVE_FOLLOW_UP_MS });
    const session = startLiveSocket({
      urls: LITVM_WS_URLS,
      onEvent: oncePerBlock(() => waves.trigger()),
      onStatus: (connected) => {
        setLiveSocketConnected(connected);
        setSocketLive(connected);
      },
    });
    sessionRef.current = session;
    session.setAccount(accountRef.current);

    let filterTimer: number | undefined;
    const refreshFilter = () => {
      filterTimer = undefined;
      const mounted = cache.getAll().filter((query) => query.getObserversCount() > 0);
      session.setAddresses(liveWatchAddresses(mounted.map((query) => query.queryKey)));
    };
    refreshFilter();
    const unsubscribe = cache.subscribe((event) => {
      if (event.type !== "observerAdded" && event.type !== "observerRemoved" && event.type !== "removed") return;
      if (filterTimer === undefined) filterTimer = window.setTimeout(refreshFilter, FILTER_DEBOUNCE_MS);
    });
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      session.wake();
      if (missedWave) {
        missedWave = false;
        waves.trigger();
      }
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);

    return () => {
      unsubscribe();
      if (filterTimer !== undefined) window.clearTimeout(filterTimer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      waves.dispose();
      session.dispose();
      sessionRef.current = undefined;
      setLiveSocketConnected(false);
    };
  }, [queryClient]);

  useEffect(() => {
    accountRef.current = address;
    sessionRef.current?.setAccount(address);
  }, [address]);

  return null;
}
