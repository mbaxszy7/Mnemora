import { useCallback, useEffect, useRef } from "react";
import type { IPCResult } from "@shared/ipc-types";
import type { SearchQuery, SearchResult } from "@shared/context-types";

function makeRequestId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Provide a stable requestId for Context Search and helpers to search/cancel.
 * Same hook instance reuses one requestId so a new search auto-cancels the previous
 * when using the same id on the main side. Also exposes explicit cancel().
 */
export function useContextSearch() {
  const requestIdRef = useRef<string>(makeRequestId());
  const latestCancelRef = useRef<(() => Promise<IPCResult<boolean>>) | null>(null);

  const cancel = useCallback(async () => {
    if (!requestIdRef.current) {
      return {
        success: false,
        error: { code: "UNKNOWN", message: "missing requestId" },
      } as IPCResult<boolean>;
    }
    latestCancelRef.current = null;
    return window.contextGraphApi.cancelSearch(requestIdRef.current);
  }, []);

  const search = useCallback(
    (query: Omit<SearchQuery, "requestId">): Promise<IPCResult<SearchResult>> => {
      const requestId = requestIdRef.current;
      latestCancelRef.current = () => window.contextGraphApi.cancelSearch(requestId);
      return window.contextGraphApi.search({ ...query, requestId });
    },
    []
  );

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

  return { requestId: requestIdRef.current, search, cancel };
}
