import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { QueryProvider } from "./providers/query-provider.tsx";
import { I18nProvider } from "./providers/i18n-provider.tsx";
import "./index.css";

// Session storage key for tracking if this is a fresh app launch
const SESSION_KEY = "mnemora_session_active";
const LAST_ROUTE_KEY = "mnemora_last_route";

// Check if this is a fresh app launch (new session) or window reopen
const isNewSession = !sessionStorage.getItem(SESSION_KEY);
sessionStorage.setItem(SESSION_KEY, "true");

// Determine initial route
if (!window.location.hash || window.location.hash === "#/") {
  if (isNewSession) {
    // Fresh app launch - show splash screen
    window.location.hash = "#/splash";
  } else {
    // Window reopened (macOS) - restore last route or go to home
    const lastRoute = localStorage.getItem(LAST_ROUTE_KEY);
    if (lastRoute && lastRoute !== "/splash") {
      window.location.hash = `#${lastRoute}`;
    } else {
      window.location.hash = "#/";
    }
  }
}

// Save current route to localStorage on route changes
router.subscribe((state) => {
  const currentPath = state.location.pathname;
  // Don't save splash screen as last route
  if (currentPath !== "/splash") {
    localStorage.setItem(LAST_ROUTE_KEY, currentPath);
  }
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <I18nProvider>
      <QueryProvider>
        <RouterProvider router={router} />
      </QueryProvider>
    </I18nProvider>
  </React.StrictMode>
);

// Use contextBridge
window.ipcRenderer.on("main-process-message", (_event, message) => {
  console.log(message);
});
