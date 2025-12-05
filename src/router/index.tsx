import { createHashRouter } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import {
  HomePage,
  SettingsPage,
  AboutPage,
  NotFoundPage,
  VLMDemoPage,
  SplashScreen,
} from "@/pages";

// Use HashRouter for Electron environment compatibility
// Start at /splash on initial load
export const router = createHashRouter([
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
]);
