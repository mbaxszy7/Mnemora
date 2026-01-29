import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
// import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/providers/theme-provider";
import {
  Languages,
  Bot,
  ScrollText,
  ChevronRight,
  Shield,
  CheckCircle,
  XCircle,
  Settings,
  Monitor,
  Activity,
  ArrowLeft,
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
  const { theme, setTheme } = useTheme();

  // Permission state
  const [screenRecordingStatus, setScreenRecordingStatus] = useState<PermissionStatus | null>(null);
  const [accessibilityStatus, setAccessibilityStatus] = useState<PermissionStatus | null>(null);
  const [isRequestingScreenRecording, setIsRequestingScreenRecording] = useState(false);
  const [isRequestingAccessibility, setIsRequestingAccessibility] = useState(false);
  const [isOpeningMonitoring, setIsOpeningMonitoring] = useState(false);

  const screenRecordingStatusRef = useRef<PermissionStatus | null>(null);
  const accessibilityStatusRef = useRef<PermissionStatus | null>(null);

  useEffect(() => {
    screenRecordingStatusRef.current = screenRecordingStatus;
    accessibilityStatusRef.current = accessibilityStatus;
  }, [screenRecordingStatus, accessibilityStatus]);

  // Check permission status
  const allGranted = useCallback(
    (screen?: PermissionStatus | null, accessibility?: PermissionStatus | null) =>
      screen === "granted" && accessibility === "granted",
    []
  );
  const grantedRef = useRef(false);

  const checkPermission = useCallback(async () => {
    // Skip IPC if already fully granted
    if (
      grantedRef.current ||
      allGranted(screenRecordingStatusRef.current, accessibilityStatusRef.current)
    ) {
      return;
    }
    try {
      const result = await window.permissionApi.check();
      if (result.success && result.data) {
        screenRecordingStatusRef.current = result.data.screenRecording;
        accessibilityStatusRef.current = result.data.accessibility;
        setScreenRecordingStatus(result.data.screenRecording);
        setAccessibilityStatus(result.data.accessibility);

        if (allGranted(result.data.screenRecording, result.data.accessibility)) {
          grantedRef.current = true;
        }
      }
    } catch (error) {
      console.error("Failed to check permission:", error);
    }
  }, [allGranted]);

  useEffect(() => {
    void checkPermission();

    const unsubscribePermissionChanged =
      typeof window.permissionApi.onStatusChanged === "function"
        ? window.permissionApi.onStatusChanged((payload) => {
            screenRecordingStatusRef.current = payload.screenRecording;
            accessibilityStatusRef.current = payload.accessibility;
            setScreenRecordingStatus(payload.screenRecording);
            setAccessibilityStatus(payload.accessibility);

            if (allGranted(payload.screenRecording, payload.accessibility)) {
              grantedRef.current = true;
            }
          })
        : null;

    const handleFocus = () => {
      void checkPermission();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void checkPermission();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribePermissionChanged?.();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkPermission, allGranted]);

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

  const handleOpenMonitoringDashboard = async () => {
    if (isOpeningMonitoring) return;
    setIsOpeningMonitoring(true);
    try {
      const result = await window.monitoringApi.openDashboard();
      if (result.success && result.data) {
        toast.success(t("settings.monitoring.opened"), {
          description: result.data.url,
        });
      } else {
        toast.error(t("settings.monitoring.openFailed"));
      }
    } catch (error) {
      console.error("Failed to open monitoring dashboard:", error);
      toast.error(t("settings.monitoring.openFailed"));
    } finally {
      setIsOpeningMonitoring(false);
    }
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
      <div className="space-y-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/", { type: "slide-right", duration: 300 })}
          className="mb-2"
        >
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("nav.home")}
        </Button>
        <div>
          <h1 className="text-3xl font-bold">{t("settings.title")}</h1>
          <p className="text-muted-foreground mt-2">{t("settings.description")}</p>
        </div>
      </div>

      <div className="space-y-6">
        {/* Language Selector */}
        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="language" className="flex items-center gap-2">
              <Languages className="h-4 w-4" />
              {t("settings.language")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("settings.languageDescription")}</p>
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

        {/* Context Rules */}
        <button
          onClick={() => navigate("/settings/context-rules", { type: "slide-left", duration: 300 })}
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <ScrollText className="h-4 w-4" />
              {t("contextRules.title", "Context Rules")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "contextRules.description",
                "Add markdown rules that will be injected into screenshot-processing prompts"
              )}
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </button>

        {/* Monitoring Dashboard */}
        <button
          onClick={handleOpenMonitoringDashboard}
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <Activity className="h-4 w-4" />
              {t("settings.monitoring.title")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("settings.monitoring.description")}</p>
          </div>
          <div className="flex items-center gap-2">
            {isOpeningMonitoring && (
              <Badge variant="secondary">{t("settings.monitoring.opening")}</Badge>
            )}
            <ChevronRight className="h-5 w-5 text-muted-foreground" />
          </div>
        </button>

        {/* Capture Source Settings */}
        <button
          onClick={() =>
            navigate("/settings/capture-sources", { type: "slide-left", duration: 300 })
          }
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <Monitor className="h-4 w-4" />
              {t("captureSourceSettings.title", "Capture Source Settings")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t(
                "captureSourceSettings.description",
                "Configure which screens and applications to capture"
              )}
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </button>

        {/* Usage Statistics */}
        <button
          onClick={() => navigate("/settings/usage", { type: "slide-left", duration: 300 })}
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <span className="h-4 w-4 flex items-center justify-center font-bold text-xs border rounded-full border-current">
                $
              </span>
              {t("usage.button.title", "Usage Statistics")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("usage.button.description", "View token usage and estimated costs")}
            </p>
          </div>
          <ChevronRight className="h-5 w-5 text-muted-foreground" />
        </button>

        {/* <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="autoStart">{t("settings.autoStart.label")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.autoStart.description")}</p>
          </div>
          <Switch
            id="autoStart"
            checked={settings.autoStart}
            onCheckedChange={() => updateSetting("autoStart")}
          />
        </div>

        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="notifications">{t("settings.notifications.label")}</Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.notifications.description")}
            </p>
          </div>
          <Switch
            id="notifications"
            checked={settings.notifications}
            onCheckedChange={() => updateSetting("notifications")}
          />
        </div> */}

        <div className="flex items-center justify-between p-4 rounded-lg border">
          <div className="space-y-0.5">
            <Label htmlFor="theme">{t("settings.appearance.label")}</Label>
            <p className="text-sm text-muted-foreground">{t("settings.appearance.description")}</p>
          </div>
          <Select value={theme} onValueChange={(value) => setTheme(value as typeof theme)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder={t("settings.appearance.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t("settings.appearance.options.system")}</SelectItem>
              <SelectItem value="light">{t("settings.appearance.options.light")}</SelectItem>
              <SelectItem value="dark">{t("settings.appearance.options.dark")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}
