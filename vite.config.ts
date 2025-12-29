import { defineConfig } from "vite";
import path from "node:path";
import fs from "node:fs";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Plugin to copy migrations folder to dist-electron
function copyMigrationsPlugin() {
  return {
    name: "copy-migrations",
    closeBundle() {
      const src = path.resolve(__dirname, "electron/database/migrations");
      const dest = path.resolve(__dirname, "dist-electron/migrations");
      if (fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true });
        console.log("✓ Copied migrations folder to dist-electron/migrations");
      }
    },
  };
}

// Shared alias configuration for both renderer and electron builds
const sharedAlias = {
  "@": path.resolve(__dirname, "./src"),
  "@shared": path.resolve(__dirname, "./shared"),
};

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart(args) {
          // Only start Electron on first launch, restart Electron process on main process changes
          // instead of restarting the entire Vite dev server
          args.startup();
        },
        vite: {
          resolve: {
            alias: sharedAlias,
          },
          build: {
            // Support top-level await in dependencies
            target: "esnext",
            rollupOptions: {
              // Externalize native modules - they will be loaded at runtime
              external: ["better-sqlite3", "node-screenshots", "sharp", "hnswlib-node"],
            },
          },
          plugins: [copyMigrationsPlugin()],
        },
      },
      preload: {
        input: path.join(__dirname, "electron/preload.ts"),
        onstart(args) {
          // Only reload renderer window on preload changes, don't restart the entire app
          args.reload();
        },
        vite: {
          resolve: {
            alias: sharedAlias,
          },
        },
      },
      // Polyfill the Electron and Node.js API for Renderer process.
      renderer: process.env.NODE_ENV === "test" ? undefined : {},
    }),
  ],
  resolve: {
    alias: sharedAlias,
  },
});
