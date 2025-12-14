import { useSuspenseQuery } from "@tanstack/react-query";
import type { GetAppsResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

/**
 * Hook to fetch the list of available applications with icons.
 * Uses useSuspenseQuery - requires Suspense boundary.
 *
 * @returns React Query result with apps data
 */
export function useCaptureApps() {
  return useSuspenseQuery<IPCResult<GetAppsResponse>>({
    queryKey: ["capture-apps"],
    queryFn: () => window.captureSourceApi.getApps(),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
