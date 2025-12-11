import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Save,
  Languages,
  Bot,
  ChevronRight,
  Shield,
  CheckCircle,
  XCircle,
  Settings,
} from "lucide-react";
import { useLanguage } from "@/hooks/use-language";
import { useViewTransition } from "@/components/core/view-transition";
import type { SupportedLanguage } from "@shared/i18n-types";
import type { PermissionStatus } from "@shared/ipc-types";

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

  // Permission state
  const [screenRecordingStatus, setScreenRecordingStatus] = useState<PermissionStatus | null>(null);
  const [accessibilityStatus, setAccessibilityStatus] = useState<PermissionStatus | null>(null);
  const [isRequestingScreenRecording, setIsRequestingScreenRecording] = useState(false);
  const [isRequestingAccessibility, setIsRequestingAccessibility] = useState(false);

  // Check permission status
  const checkPermission = useCallback(async () => {
    try {
      const result = await window.permissionApi.check();
      if (result.success && result.data) {
        setScreenRecordingStatus(result.data.screenRecording);
        setAccessibilityStatus(result.data.accessibility);
      }
    } catch (error) {
      console.error("Failed to check permission:", error);
    }
  }, []);

  useEffect(() => {
    checkPermission();
    // Poll for permission changes
    const interval = setInterval(checkPermission, 2000);
    return () => clearInterval(interval);
  }, [checkPermission]);

  const handleRequestScreenRecording = async () => {
    setIsRequestingScreenRecording(true);
    try {
      await window.permissionApi.requestScreenRecording();
      await checkPermission();
    } catch (error) {
      console.error("Failed to request permission:", error);
    } finally {
      setIsRequestingScreenRecording(false);
    }
  };

  const handleRequestAccessibility = async () => {
    setIsRequestingAccessibility(true);
    try {
      await window.permissionApi.requestAccessibility();
      await checkPermission();
    } catch (error) {
      console.error("Failed to request permission:", error);
    } finally {
      setIsRequestingAccessibility(false);
    }
  };

  const handleOpenScreenRecordingSettings = async () => {
    try {
      await window.permissionApi.openScreenRecordingSettings();
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  };

  const handleOpenAccessibilitySettings = async () => {
    try {
      await window.permissionApi.openAccessibilitySettings();
    } catch (error) {
      console.error("Failed to open settings:", error);
    }
  };

  const updateSetting = (key: keyof typeof settings) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleLanguageChange = (value: string) => {
    changeLanguage(value as SupportedLanguage);
  };

  const getPermissionStatusBadge = (
    status: PermissionStatus | null,
    type: "screenRecording" | "accessibility"
  ) => {
    switch (status) {
      case "granted":
        return (
          <Badge variant="default" className="bg-green-600">
            <CheckCircle className="h-3 w-3 mr-1" />
            {t(`permissions.settings.${type}.granted`)}
          </Badge>
        );
      case "denied":
      case "restricted":
        return (
          <Badge variant="destructive">
            <XCircle className="h-3 w-3 mr-1" />
            {t(`permissions.settings.${type}.denied`)}
          </Badge>
        );
      case "not-determined":
        return <Badge variant="secondary">{t(`permissions.settings.${type}.notDetermined`)}</Badge>;
      default:
        return <Badge variant="outline">{t("permissions.status.checking")}</Badge>;
    }
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

        {/* Permissions Section */}
        <div className="rounded-lg border divide-y">
          {/* Screen Recording Permission */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  {t("permissions.settings.screenRecording.label")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("permissions.settings.screenRecording.description")}
                </p>
              </div>
              {getPermissionStatusBadge(screenRecordingStatus, "screenRecording")}
            </div>
            {screenRecordingStatus !== "granted" && (
              <div className="flex gap-2 pt-2">
                {screenRecordingStatus === "not-determined" ? (
                  <Button
                    size="sm"
                    onClick={handleRequestScreenRecording}
                    disabled={isRequestingScreenRecording}
                  >
                    {isRequestingScreenRecording
                      ? t("permissions.status.checking")
                      : t("permissions.settings.screenRecording.grantButton")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={handleOpenScreenRecordingSettings}>
                    <Settings className="h-4 w-4 mr-2" />
                    {t("permissions.settings.screenRecording.openSettings")}
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Accessibility Permission */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-2">
                  <Shield className="h-4 w-4" />
                  {t("permissions.settings.accessibility.label")}
                </Label>
                <p className="text-sm text-muted-foreground">
                  {t("permissions.settings.accessibility.description")}
                </p>
              </div>
              {getPermissionStatusBadge(accessibilityStatus, "accessibility")}
            </div>
            {accessibilityStatus !== "granted" && (
              <div className="flex gap-2 pt-2">
                <Button
                  size="sm"
                  onClick={handleRequestAccessibility}
                  disabled={isRequestingAccessibility}
                >
                  {isRequestingAccessibility
                    ? t("permissions.status.checking")
                    : t("permissions.settings.accessibility.grantButton")}
                </Button>
                <Button size="sm" variant="outline" onClick={handleOpenAccessibilitySettings}>
                  <Settings className="h-4 w-4 mr-2" />
                  {t("permissions.settings.accessibility.openSettings")}
                </Button>
              </div>
            )}
          </div>
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
