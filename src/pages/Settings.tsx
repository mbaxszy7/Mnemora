import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Save, Languages, Bot, ChevronRight } from "lucide-react";
import { useLanguage } from "@/hooks/use-language";
import { useViewTransition } from "@/components/core/view-transition";
import type { SupportedLanguage } from "@shared/i18n-types";

export default function SettingsPage() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const {
    currentLanguage,
    changeLanguage,
    isLoading: isLanguageLoading,
    supportedLanguages,
    languageDisplayNames,
  } = useLanguage();

  const [settings, setSettings] = useState({
    autoStart: false,
    notifications: true,
    darkMode: true,
  });

  const updateSetting = (key: keyof typeof settings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleLanguageChange = (value: string) => {
    changeLanguage(value as SupportedLanguage);
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold">{t("settings.title")}</h1>
        <p className="text-muted-foreground mt-2">Manage your application preferences</p>
      </div>

      <div className="space-y-6">
        {/* Language Selector */}
        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="language" className="flex items-center gap-2">
              <Languages className="h-4 w-4" />
              {t("settings.language")}
            </Label>
            <p className="text-sm text-muted-foreground">Select your preferred language</p>
          </div>
          <Select
            value={currentLanguage}
            onValueChange={handleLanguageChange}
            disabled={isLanguageLoading}
          >
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t("settings.language")} />
            </SelectTrigger>
            <SelectContent>
              {supportedLanguages.map((lang) => (
                <SelectItem key={lang} value={lang}>
                  {languageDisplayNames[lang]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* LLM Configuration */}
        <button
          onClick={() => navigate("/settings/llm-config", { type: "slide-left", duration: 300 })}
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <Bot className="h-4 w-4" />
              {t("llmConfig.title")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("llmConfig.description")}</p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </button>

        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="autoStart">Launch at Startup</Label>
            <p className="text-sm text-muted-foreground">
              Automatically run Mnemora when system starts
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
            <Label htmlFor="notifications">Notifications</Label>
            <p className="text-sm text-muted-foreground">
              Receive smart insights and reminder notifications
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
            <Label htmlFor="darkMode">Dark Mode</Label>
            <p className="text-sm text-muted-foreground">Use dark theme interface</p>
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
        {t("common.buttons.save")}
      </Button>
    </div>
  );
}
