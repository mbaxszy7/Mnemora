#!/usr/bin/env node
/* global process, console */
/**
 * Cross-platform wrapper for building the macOS-only window_inspector binary.
 * - On macOS, delegates to build.sh (bash) to produce dist/window_inspector/window_inspector.
 * - On other platforms, no-op so dev/build flows don't fail.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isMac = process.platform === "darwin";

if (!isMac) {
  console.log("Skipping window_inspector build: macOS-only component");
  process.exit(0);
}

const scriptPath = join(__dirname, "build.sh");

const result = spawnSync(scriptPath, {
  stdio: "inherit",
  shell: true,
  env: { ...process.env },
});

if (result.error) {
  console.error("Failed to run build.sh:", result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
