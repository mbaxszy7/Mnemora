import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Save } from "lucide-react";

export default function SettingsPage() {
  const [settings, setSettings] = useState({
    autoStart: false,
    notifications: true,
    darkMode: true,
  });

  const updateSetting = (key: keyof typeof settings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold">设置</h1>
        <p className="text-muted-foreground mt-2">管理你的应用偏好设置</p>
      </div>

      <div className="space-y-6">
        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="autoStart">开机自启动</Label>
            <p className="text-sm text-muted-foreground">
              系统启动时自动运行 Mnemora
            </p>
          </div>
          <Switch
            id="autoStart"
            checked={settings.autoStart}
            onCheckedChange={() => updateSetting("autoStart")}
          />
        </div>

        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="notifications">通知提醒</Label>
            <p className="text-sm text-muted-foreground">
              接收智能洞见和提醒通知
            </p>
          </div>
          <Switch
            id="notifications"
            checked={settings.notifications}
            onCheckedChange={() => updateSetting("notifications")}
          />
        </div>

        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="darkMode">深色模式</Label>
            <p className="text-sm text-muted-foreground">
              使用深色主题界面
            </p>
          </div>
          <Switch
            id="darkMode"
            checked={settings.darkMode}
            onCheckedChange={() => updateSetting("darkMode")}
          />
        </div>
      </div>

      <Button className="w-full">
        <Save className="mr-2 h-4 w-4" />
        保存设置
      </Button>
    </div>
  );
}
