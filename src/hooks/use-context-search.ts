import { useCallback, useEffect, useRef } from "react";
import type { IPCResult } from "@shared/ipc-types";
import type { SearchResult } from "@shared/context-types";

/**
 * Helpers for context search and cancellation using the simplified search API.
 */
export function useContextSearch() {
  const latestCancelRef = useRef<(() => Promise<IPCResult<boolean>>) | null>(null);

  const cancel = useCallback(async () => {
    latestCancelRef.current = null;
    return window.contextGraphApi.cancelSearch();
  }, []);

  const search = useCallback((query: string): Promise<IPCResult<SearchResult>> => {
    latestCancelRef.current = () => window.contextGraphApi.cancelSearch();
    return window.contextGraphApi.search(query);
  }, []);

  useEffect(() => {
    return () => {
      // Best-effort cancel on unmount
      if (latestCancelRef.current) {
        latestCancelRef.current().catch(() => {
          /* ignore */
        });
      }
    };
  }, []);

  return { search, cancel };
}
