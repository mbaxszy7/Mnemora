import { useSuspenseQuery } from "@tanstack/react-query";
import type { GetScreensResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

export const CAPTURE_SCREENS_QUERY_KEY = ["capture-screens"] as const;

export function useCaptureScreens() {
  return useSuspenseQuery<IPCResult<GetScreensResponse>>({
    queryKey: CAPTURE_SCREENS_QUERY_KEY,
    queryFn: () => window.captureSourceApi.getScreens(),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
