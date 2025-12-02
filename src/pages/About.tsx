import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Brain, Github, ArrowLeft } from "lucide-react";

export default function AboutPage() {
  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div className="text-center space-y-4">
        <Brain className="w-20 h-20 text-primary mx-auto" />
        <h1 className="text-3xl font-bold">关于 Mnemora</h1>
        <p className="text-muted-foreground">版本 0.0.1</p>
      </div>

      <div className="p-6 rounded-lg border bg-card space-y-4">
        <h2 className="text-xl font-semibold">技术栈</h2>
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
        <h2 className="text-xl font-semibold">路由最佳实践</h2>
        <ul className="space-y-2 text-sm text-muted-foreground">
          <li>• 使用 createHashRouter 适配 Electron</li>
          <li>• 集中式路由配置 (src/router/index.tsx)</li>
          <li>• Layout 组件 + Outlet 嵌套路由</li>
          <li>• NavLink 实现导航高亮</li>
          <li>• useNavigate 编程式导航</li>
        </ul>
      </div>

      <div className="flex gap-4">
        <Button variant="outline" asChild className="flex-1">
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            返回首页
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
