/* eslint-disable react-refresh/only-export-components */
import { createHashRouter, Outlet } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import {
  HomePage,
  SettingsPage,
  SettingsLLMConfigPage,
  CaptureSourceSettingsPage,
  NotFoundPage,
  SplashScreen,
  LLMConfigPage,
  UsagePage,
  SearchResultsPage,
} from "@/pages";
import { ViewTransitionProvider } from "@/components/core/view-transition";
import { Toaster } from "@/components/ui/sonner";

function AppRoot() {
  return (
    <ViewTransitionProvider>
      <Outlet />
      <Toaster closeButton richColors />
    </ViewTransitionProvider>
  );
}

export const router = createHashRouter([
  {
    element: <AppRoot />,
    children: [
      {
        path: "/splash",
        element: <SplashScreen />,
      },
      {
        path: "/llm-config",
        element: <LLMConfigPage />,
      },
      {
        path: "/",
        element: <RootLayout />,
        children: [
          {
            index: true,
            element: <HomePage />,
          },
          {
            path: "settings",
            element: <SettingsPage />,
          },
          {
            path: "settings/llm-config",
            element: <SettingsLLMConfigPage />,
          },
          {
            path: "settings/capture-sources",
            element: <CaptureSourceSettingsPage />,
          },
          {
            path: "settings/usage",
            element: <UsagePage />,
          },
          {
            path: "search-results",
            element: <SearchResultsPage />,
          },
          {
            path: "*",
            element: <NotFoundPage />,
          },
        ],
      },
    ],
  },
]);
