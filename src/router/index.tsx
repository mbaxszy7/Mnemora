import { createHashRouter } from "react-router-dom";
import RootLayout from "@/layouts/RootLayout";
import { HomePage, SettingsPage, AboutPage, NotFoundPage, VLMDemoPage } from "@/pages";

// 使用 HashRouter 适配 Electron 环境
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
