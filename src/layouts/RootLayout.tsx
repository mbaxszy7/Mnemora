import { useNavigate, Outlet } from "react-router-dom";
import { useEffect } from "react";
import { Navbar } from "@/components/core/Navbar";
import { useInitServices } from "@/hooks/use-capture-source";

export default function RootLayout() {
  const { initServices } = useInitServices();
  const navigate = useNavigate();

  useEffect(() => {
    initServices();
  }, [initServices]);

  useEffect(() => {
    const cleanup = window.appApi.onNavigate((path) => {
      navigate(path);
    });
    return cleanup;
  }, [navigate]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="container mx-auto px-4 py-6" style={{ viewTransitionName: "main-content" }}>
        <Outlet />
      </main>
    </div>
  );
}
