import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Brain, Zap, Eye } from "lucide-react";

function App() {
  const [count, setCount] = useState(0);

  // Demo React Query usage
  const { data: queryStatus } = useQuery({
    queryKey: ["demo"],
    queryFn: () => Promise.resolve("React Query is working!"),
  });

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-8">
      <div className="max-w-2xl w-full space-y-8">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="flex items-center justify-center gap-3">
            <Brain className="w-12 h-12 text-primary" />
            <h1 className="text-4xl font-bold tracking-tight">Mnemora</h1>
          </div>
          <p className="text-muted-foreground text-lg">让你的屏幕成为第二大脑</p>
          <p className="text-sm text-muted-foreground">
            Intelligent context-aware desktop application
          </p>
        </div>

        {/* Feature Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-6 rounded-lg border bg-card">
            <Eye className="w-8 h-8 text-primary mb-3" />
            <h3 className="font-semibold mb-2">Screen Awareness</h3>
            <p className="text-sm text-muted-foreground">持续的屏幕感知与语义理解</p>
          </div>
          <div className="p-6 rounded-lg border bg-card">
            <Zap className="w-8 h-8 text-primary mb-3" />
            <h3 className="font-semibold mb-2">Smart Insights</h3>
            <p className="text-sm text-muted-foreground">实时洞见和智能建议</p>
          </div>
        </div>

        {/* Demo Section */}
        <div className="p-6 rounded-lg border bg-card space-y-4">
          <h3 className="font-semibold">Tech Stack Demo</h3>

          {/* Tailwind + shadcn Button */}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setCount((c) => c + 1)}>Count: {count}</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
          </div>

          {/* React Query Status */}
          <div className="text-sm text-muted-foreground">
            <span className="font-medium">React Query: </span>
            <span className="text-green-600">{queryStatus ?? "Loading..."}</span>
          </div>

          {/* Stack Info */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>✓ React 19 + TypeScript</p>
            <p>✓ Electron + Vite</p>
            <p>✓ Tailwind CSS + shadcn/ui</p>
            <p>✓ TanStack React Query</p>
            <p>✓ Lucide Icons</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
