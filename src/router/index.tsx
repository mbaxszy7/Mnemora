/* eslint-disable react-refresh/only-export-components */
import { createHashRouter, Outlet } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import {
  HomePage,
  SettingsPage,
  AboutPage,
  NotFoundPage,
  VLMDemoPage,
  SplashScreen,
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
