import { useNavigate, Outlet } from "react-router-dom";
import { useEffect } from "react";
import { useAiFuseToast } from "@/hooks/use-ai-fuse-toast";

export default function RootLayout() {
  const navigate = useNavigate();

  // Listen for AI failure circuit breaker events
  useAiFuseToast();

  useEffect(() => {
    const cleanup = window.appApi.onNavigate((path) => {
      navigate(path);
    });
    return cleanup;
  }, [navigate]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <main className="container mx-auto px-4 py-6" style={{ viewTransitionName: "main-content" }}>
        <Outlet />
      </main>
    </div>
  );
}
