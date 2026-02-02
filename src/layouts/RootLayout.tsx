import { useNavigate, Outlet } from "react-router-dom";
import { useEffect } from "react";
import { useNotification } from "@/hooks/use-notification";
import { TitleBar } from "@/components/core/TitleBar";

export default function RootLayout() {
  const navigate = useNavigate();

  useNotification();

  useEffect(() => {
    const cleanup = window.appApi.onNavigate((path) => {
      navigate(path);
    });
    return cleanup;
  }, [navigate]);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      <TitleBar />

      <main
        className="flex-1 container mx-auto px-4 pb-6 overflow-auto"
        style={{ viewTransitionName: "main-content" }}
      >
        <Outlet />
      </main>
    </div>
  );
}
