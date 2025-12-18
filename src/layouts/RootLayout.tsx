import { Outlet } from "react-router-dom";
import { Navbar } from "@/components/core/Navbar";
import { useInitServices } from "@/hooks/use-capture-source";
import { useEffect } from "react";

export default function RootLayout() {
  const { initServices } = useInitServices();
  useEffect(() => {
    initServices();
  }, [initServices]);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="container mx-auto px-4 py-6" style={{ viewTransitionName: "main-content" }}>
        <Outlet />
      </main>
    </div>
  );
}
