/* eslint-disable react-refresh/only-export-components */
import { createHashRouter, Outlet } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import {
  HomePage,
  SettingsPage,
  SettingsLLMConfigPage,
  CaptureSourceSettingsPage,
  AboutPage,
  NotFoundPage,
  VLMDemoPage,
  SplashScreen,
  LLMConfigPage,
} from "@/pages";
import { ViewTransitionProvider } from "@/components/core/view-transition";

function AppRoot() {
  return (
    <ViewTransitionProvider>
      <Outlet />
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
            path: "about",
            element: <AboutPage />,
          },
          {
            path: "vlm-demo",
            element: <VLMDemoPage />,
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
