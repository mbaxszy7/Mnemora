import { useSuspenseQuery } from "@tanstack/react-query";
import type { GetAppsResponse } from "@shared/capture-source-types";
import type { IPCResult } from "@shared/ipc-types";

export const CAPTURE_APPS_QUERY_KEY = ["capture-apps"] as const;

export function useCaptureApps() {
  return useSuspenseQuery<IPCResult<GetAppsResponse>>({
    queryKey: CAPTURE_APPS_QUERY_KEY,
    queryFn: () => window.captureSourceApi.getApps(),
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
}
