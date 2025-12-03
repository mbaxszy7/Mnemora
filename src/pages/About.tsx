import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Brain, Github, ArrowLeft } from "lucide-react";

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="text-center space-y-4">
        <Brain className="w-20 h-20 text-primary mx-auto" />
        <h1 className="text-3xl font-bold">About Mnemora</h1>
        <p className="text-muted-foreground">Version 0.0.1</p>
      </div>

      <div className="p-6 rounded-lg border bg-card space-y-4">
        <h2 className="text-xl font-semibold">Tech Stack</h2>
        <ul className="space-y-2 text-muted-foreground">
          <li>✓ React 19 + TypeScript</li>
          <li>✓ Electron + Vite</li>
          <li>✓ React Router v7 (Hash Router)</li>
          <li>✓ Tailwind CSS + shadcn/ui</li>
          <li>✓ TanStack React Query</li>
          <li>✓ Lucide Icons</li>
        </ul>
      </div>

      <div className="p-6 rounded-lg border bg-card space-y-4">
        <h2 className="text-xl font-semibold">Routing Best Practices</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>• Using createHashRouter for Electron compatibility</li>
          <li>• Centralized route configuration (src/router/index.tsx)</li>
          <li>• Layout component + Outlet nested routing</li>
          <li>• NavLink for navigation highlighting</li>
          <li>• useNavigate for programmatic navigation</li>
        </ul>
      </div>

      <div className="flex gap-4">
        <Button variant="outline" asChild className="flex-1">
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Link>
        </Button>
        <Button variant="outline" className="flex-1">
          <Github className="mr-2 h-4 w-4" />
          GitHub
        </Button>
      </div>
    </div>
  );
}
