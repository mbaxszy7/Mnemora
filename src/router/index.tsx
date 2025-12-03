import { createHashRouter } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import { HomePage, SettingsPage, AboutPage, NotFoundPage, VLMDemoPage } from "@/pages";

// Use HashRouter for Electron environment compatibility
export const router = createHashRouter([
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
