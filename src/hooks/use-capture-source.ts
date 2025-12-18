import { useCallback } from "react";

// Keep initialization state across component unmounts/remounts
let captureServicesInitialized = false;

/**
 * Hook to initialize capture services once when permissions are granted
 */
export function useInitServices() {
  const initServices = useCallback(async () => {
    if (captureServicesInitialized) return;
    try {
      const result = await window.captureSourceApi.initServices();
      if (result.success) {
        captureServicesInitialized = true;
        console.log("Capture services initialized");
      }
    } catch (error) {
      console.error("Failed to initialize capture services:", error);
    }
  }, []);

  return { initServices };
}
