import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

// Full coverage report (includes screenshot-processing orchestration files),
// but does not enforce global thresholds. This is useful for tracking
// long-tail coverage without blocking CI merges.
export default defineConfig(() => {
  const gateExcluded = [
    "electron/services/screenshot-processing/{vlm-processor,activity-monitor-service,context-search-service,deep-search-service,thread-runtime-service,thread-repository}.ts",
    "electron/services/screenshot-processing/schedulers/{activity-timeline-scheduler,batch-vlm-scheduler,thread-scheduler,vector-document-scheduler,ocr-scheduler}.ts",
  ];

  const baseConfigObject = (
    typeof baseConfig === "object" && baseConfig !== null ? baseConfig : {}
  ) as {
    test?: {
      coverage?: {
        exclude?: string[];
      };
    };
  };
  const baseExclude = baseConfigObject.test?.coverage?.exclude;
  const exclude =
    baseExclude?.filter((pattern) => !gateExcluded.includes(pattern)) ?? baseExclude ?? [];

  return {
    ...baseConfigObject,
    test: {
      ...baseConfigObject.test,
      coverage: {
        ...baseConfigObject.test?.coverage,
        // Write to a separate directory to avoid clobbering the gate report.
        reportsDirectory: "./coverage-full",
        // Do not fail the run based on coverage thresholds.
        thresholds: {
          lines: 0,
          functions: 0,
          branches: 0,
          statements: 0,
        },
        exclude,
      },
    },
  };
});
