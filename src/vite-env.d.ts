/// <reference types="vite/client" />

// Re-export Window interface from electron-env.d.ts for renderer process
// This ensures type consistency between electron and vite environments
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../electron/electron-env.d.ts" />
