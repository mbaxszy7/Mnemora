import { Outlet } from "react-router-dom";
import { Navbar } from "@/components/Navbar";

export default function RootLayout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <Navbar />
      <main className="container mx-auto px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
