import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

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
          },
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
