import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "lcov"],
      reportsDirectory: "./coverage",
      reportOnFailure: true,
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
      include: [
        "electron/**/*.ts",
        "shared/**/*.ts",
        // Frontend coverage whitelist: focus on logic-dense modules
        "src/hooks/use-context-search.ts",
        "src/hooks/use-ai-fuse-toast.ts",
        "src/hooks/use-language.ts",
        "src/layouts/RootLayout.tsx",
        "src/components/core/view-transition/use-view-transition.ts",
        "src/components/core/view-transition/transition-core.ts",
        "src/components/core/view-transition/use-transition-state.ts",
        "src/components/core/view-transition/provider.tsx",
        "src/components/core/view-transition/presets.ts",
        "src/lib/utils.ts",
      ],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/*.property.test.*",
        "**/*.d.ts",
        "**/node_modules/**",
        "**/test-utils/**",
        // Frontend non-source artifacts
        "src/**/*.css",
        "src/**/*.svg",
        // Entry points & config
        "electron/electron-env.d.ts",
        "electron/preload.ts",
        "electron/env.ts",
        "electron/main.ts",
        "electron/services/**/events.ts",
        "electron/services/screen-capture/index.ts",
        // Database layer (integration)
        "electron/database/**",
        // IPC handlers (thin glue code)
        "electron/ipc/**",
        // Monitoring (HTTP server, perf_hooks, DB polling)
        "electron/services/monitoring/monitoring-server.ts",
        "electron/services/monitoring/metrics-collector.ts",
        // Screenshot-processing orchestration modules (kept out of coverage gates)
        "electron/services/screenshot-processing/{vlm-processor,activity-monitor-service,context-search-service,deep-search-service,thread-runtime-service,thread-repository}.ts",
        "electron/services/screenshot-processing/schedulers/{activity-timeline-scheduler,batch-vlm-scheduler,thread-scheduler,vector-document-scheduler,ocr-scheduler}.ts",
        // Shared: type-only and barrel modules
        "shared/**/*-types.ts",
        "shared/index.ts",
      ],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "./shared"),
    },
  },
});
