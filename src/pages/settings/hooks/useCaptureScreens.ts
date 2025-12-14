import { useSuspenseQuery } from "@tanstack/react-query";
import type { GetScreensResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

/**
 * Hook to fetch the list of available screens with thumbnails.
 * Uses useSuspenseQuery - requires Suspense boundary.
 *
 * @returns React Query result with screens data
 */
export function useCaptureScreens() {
  return useSuspenseQuery<IPCResult<GetScreensResponse>>({
    queryKey: ["capture-screens"],
    queryFn: () => window.captureSourceApi.getScreens(),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
