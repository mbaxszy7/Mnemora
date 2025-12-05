import { Outlet } from "react-router-dom";
import { Navbar } from "@/components/core/Navbar";

export default function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="container mx-auto px-4 py-6" style={{ viewTransitionName: "main-content" }}>
        <Outlet />
      </main>
    </div>
  );
}
