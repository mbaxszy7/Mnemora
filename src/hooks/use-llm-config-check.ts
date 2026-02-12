import { useState, useEffect, useRef } from "react";

const LLM_CHECK_RETRY_DELAYS_MS = [50, 100, 200, 400, 450] as const;
const LLM_CHECK_RETRY_BUDGET_MS = 1200;

export type ConfigCheckStatus = "configured" | "not_configured" | "unknown";

export interface LlmConfigCheckResult {
  checked: boolean;
  status: ConfigCheckStatus;
}

function shouldRetryLlmCheck(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No handler registered/i.test(message);
}

export function useLlmConfigCheck(): LlmConfigCheckResult {
  const [result, setResult] = useState<LlmConfigCheckResult>({
    checked: false,
    status: "unknown",
  });
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const check = async () => {
      const startAt = Date.now();

      try {
        for (let retryCount = 0; ; retryCount += 1) {
          try {
            const res = await window.llmConfigApi.check();
            setResult({
              checked: true,
              status: res.configured ? "configured" : "not_configured",
            });
            return;
          } catch (error) {
            const elapsed = Date.now() - startAt;
            const canRetry =
              shouldRetryLlmCheck(error) &&
              retryCount < LLM_CHECK_RETRY_DELAYS_MS.length &&
              elapsed < LLM_CHECK_RETRY_BUDGET_MS;

            if (!canRetry) throw error;

            await new Promise((r) => setTimeout(r, LLM_CHECK_RETRY_DELAYS_MS[retryCount]));
          }
        }
      } catch (error) {
        console.error("Failed to check LLM configuration:", error);
        setResult({ checked: true, status: "unknown" });
      }
    };

    void check();
  }, []);

  return result;
}
