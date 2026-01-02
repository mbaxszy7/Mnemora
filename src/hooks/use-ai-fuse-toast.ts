/**
 * Hook to listen for AI failure circuit breaker events and show toast notifications
 */

import { useEffect } from "react";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import { IPC_CHANNELS } from "@shared/ipc-types";
import type { AIFailureFuseTrippedPayload } from "@shared/ipc-types";

export function useAiFuseToast(): void {
  const navigate = useNavigate();

  useEffect(() => {
    const handler = (_event: unknown, payload: AIFailureFuseTrippedPayload) => {
      const toastId = "ai-fuse-tripped";
      toast.error(
        `AI failures detected: ${payload.count} failures in ${Math.round(payload.windowMs / 1000)}s. Screen capture stopped. Please check LLM configuration.`,
        {
          id: toastId,
          duration: Infinity,
          action: {
            label: "Open LLM Config",
            onClick: () => {
              navigate("/settings/llm-config");
            },
          },
        }
      );
    };

    window.ipcRenderer.on(IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED, handler);
    return () => {
      window.ipcRenderer.off(IPC_CHANNELS.AI_FAILURE_FUSE_TRIPPED, handler);
    };
  }, [navigate]);
}
