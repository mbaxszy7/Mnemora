import { defineConfig } from "vite";
import path from "node:path";
import electron from "vite-plugin-electron/simple";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        onstart(args) {
          // 只在首次启动时启动 Electron，后续主进程变化时只重启 Electron 进程
          // 而不是整个 Vite dev server
          args.startup();
        },
      },
      preload: {
        input: path.join(__dirname, "electron/preload.ts"),
        onstart(args) {
          // preload 变化时只刷新渲染进程窗口，不重启整个应用
          args.reload();
        },
      },
      // Polyfill the Electron and Node.js API for Renderer process.
      renderer:
        process.env.NODE_ENV === "test"
          ? undefined
          : {},
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
