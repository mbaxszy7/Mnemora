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
        <h1 className="text-4xl font-bold tracking-tight">
          让你的屏幕成为第二大脑
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Mnemora 是一款智能上下文感知桌面应用，持续理解你的屏幕内容，提供实时洞见和智能建议。
        </p>
        <div className="flex justify-center gap-4 pt-4">
          <Button size="lg" onClick={() => navigate("/about")}>
            了解更多
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => navigate("/settings")}>
            开始配置
          </Button>
        </div>
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="p-6 rounded-lg border bg-card">
          <Eye className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Screen Awareness</h3>
          <p className="text-muted-foreground">
            持续的屏幕感知与语义理解，自动识别你正在处理的内容和上下文。
          </p>
        </div>
        <div className="p-6 rounded-lg border bg-card">
          <Zap className="w-10 h-10 text-primary mb-4" />
          <h3 className="text-xl font-semibold mb-2">Smart Insights</h3>
          <p className="text-muted-foreground">
            基于上下文的实时洞见和智能建议，帮助你更高效地完成工作。
          </p>
        </div>
      </div>
    </div>
  );
}
