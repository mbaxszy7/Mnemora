import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Brain, Zap, Eye, ArrowRight } from "lucide-react";

export default function HomePage() {
  const navigate = useNavigate();

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Hero */}
      <div className="text-center space-y-4 py-8">
        <div className="flex items-center justify-center gap-3">
          <Brain className="w-16 h-16 text-primary" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight">Turn Your Screen Into a Second Brain</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Mnemora is an intelligent context-aware desktop app that continuously understands your
          screen content, providing real-time insights and smart suggestions.
        </p>
        <div className="flex justify-center gap-4 pt-4">
          <Button size="lg" onClick={() => navigate("/about")}>
            Learn More
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate("/settings")}>
            Get Started
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-6 rounded-lg border bg-card">
          <Eye className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Screen Awareness</h3>
          <p className="text-muted-foreground">
            Continuous screen perception and semantic understanding, automatically recognizing the
            content and context you're working with.
          </p>
        </div>
        <div className="p-6 rounded-lg border bg-card">
          <Zap className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Smart Insights</h3>
          <p className="text-muted-foreground">
            Context-based real-time insights and intelligent suggestions to help you work more
            efficiently.
          </p>
        </div>
      </div>
    </div>
  );
}
