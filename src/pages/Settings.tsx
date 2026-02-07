import { useCallback, useEffect, useRef, useState } from "react";
import { driver, type Driver } from "driver.js";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
// import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
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
  Bell,
  Monitor,
  Activity,
  ArrowLeft,
  Sparkles,
} from "lucide-react";
import { useLanguage } from "@/hooks/use-language";
import { useViewTransition } from "@/components/core/view-transition";
import type { SupportedLanguage } from "@shared/i18n-types";
import type { PermissionStatus } from "@shared/ipc-types";
import { useUserSettings } from "@/pages/settings/hooks/useUserSettings";
import {
  buildSettingsOnboardingSteps,
  resolveProgressOnTourClose,
  resolveSettingsProgressOnDone,
} from "@/features/onboarding";
import type { AppUpdateStatus } from "@shared/app-update-types";
import { AppUpdateCard } from "@/pages/settings/AppUpdateCard";

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
  const { settings, setOnboardingProgressAsync, isUpdatingOnboarding } = useUserSettings();
  const settingsOnboardingRef = useRef<Driver | null>(null);

  // Permission state
  const [screenRecordingStatus, setScreenRecordingStatus] = useState<PermissionStatus | null>(null);
  const [accessibilityStatus, setAccessibilityStatus] = useState<PermissionStatus | null>(null);
  const [isRequestingScreenRecording, setIsRequestingScreenRecording] = useState(false);
  const [isRequestingAccessibility, setIsRequestingAccessibility] = useState(false);
  const [isOpeningMonitoring, setIsOpeningMonitoring] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<AppUpdateStatus | null>(null);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [isOpeningUpdateDownload, setIsOpeningUpdateDownload] = useState(false);

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

  useEffect(() => {
    let mounted = true;

    const loadStatus = async () => {
      const result = await window.appUpdateApi.getStatus();
      if (mounted && result.success && result.data) {
        setUpdateStatus(result.data);
      }
    };

    void loadStatus();
    const unsubscribe = window.appUpdateApi.onStatusChanged((payload) => setUpdateStatus(payload));

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    setIsCheckingUpdate(true);
    try {
      const result = await window.appUpdateApi.checkNow();
      if (!result.success) {
        toast.error(t("settings.updates.errors.checkFailed"));
      }
    } catch (error) {
      console.error("Failed to check updates:", error);
      toast.error(t("settings.updates.errors.checkFailed"));
    } finally {
      setIsCheckingUpdate(false);
    }
  }, [t]);

  const handleRestartAndInstall = useCallback(async () => {
    setIsInstallingUpdate(true);
    try {
      const result = await window.appUpdateApi.restartAndInstall();
      if (!result.success) {
        toast.error(t("settings.updates.errors.installFailed"));
      }
    } catch (error) {
      console.error("Failed to restart and install update:", error);
      toast.error(t("settings.updates.errors.installFailed"));
    } finally {
      setIsInstallingUpdate(false);
    }
  }, [t]);

  const handleOpenUpdateDownload = useCallback(async () => {
    setIsOpeningUpdateDownload(true);
    try {
      const result = await window.appUpdateApi.openDownloadPage();
      if (!result.success) {
        toast.error(t("settings.updates.errors.openDownloadFailed"));
      }
    } catch (error) {
      console.error("Failed to open update download page:", error);
      toast.error(t("settings.updates.errors.openDownloadFailed"));
    } finally {
      setIsOpeningUpdateDownload(false);
    }
  }, [t]);

  const handleReplayOnboarding = useCallback(async () => {
    await setOnboardingProgressAsync("pending_home");
    navigate("/", { type: "slide-right", duration: 300 });
  }, [navigate, setOnboardingProgressAsync]);

  useEffect(() => {
    if (settings.onboardingProgress !== "pending_settings") return;
    if (settingsOnboardingRef.current?.isActive()) return;

    const steps = buildSettingsOnboardingSteps({ t });
    if (steps.length === 0) {
      void setOnboardingProgressAsync(resolveProgressOnTourClose());
      return;
    }

    const onboarding = driver({
      steps,
      allowClose: true,
      showProgress: true,
      stagePadding: 8,
      stageRadius: 14,
      popoverClass: "mnemora-driver-popover",
      overlayColor: "rgba(6, 9, 20, 0.55)",
      nextBtnText: t("onboarding.actions.next"),
      prevBtnText: t("onboarding.actions.back"),
      doneBtnText: t("onboarding.actions.done"),
      progressText: t("onboarding.progress", { current: "{{current}}", total: "{{total}}" }),
      onPrevClick: (_element, _step, opts) => {
        opts.driver.movePrevious();
      },
      onNextClick: (_element, _step, opts) => {
        if (opts.driver.isLastStep()) {
          void (async () => {
            await setOnboardingProgressAsync(resolveSettingsProgressOnDone());
            opts.driver.destroy();
          })();
          return;
        }
        opts.driver.moveNext();
      },
      onCloseClick: (_element, _step, opts) => {
        void setOnboardingProgressAsync(resolveProgressOnTourClose());
        opts.driver.destroy();
      },
    });

    settingsOnboardingRef.current = onboarding;
    const timer = window.setTimeout(() => onboarding.drive(), 120);

    return () => {
      window.clearTimeout(timer);
      if (settingsOnboardingRef.current?.isActive()) {
        settingsOnboardingRef.current.destroy();
      }
      settingsOnboardingRef.current = null;
    };
  }, [setOnboardingProgressAsync, settings.onboardingProgress, t]);

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
        <div
          className="flex items-center justify-between p-4 rounded-lg border"
          data-tour-id="settings-language"
        >
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
        <div className="rounded-lg border divide-y" data-tour-id="settings-permissions">
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
          data-tour-id="settings-llm-config"
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

        {/* Notifications */}
        <button
          onClick={() => navigate("/settings/notifications", { type: "slide-left", duration: 300 })}
          className="w-full flex items-center justify-between p-4 rounded-lg border hover:bg-accent transition-colors text-left"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2 cursor-pointer">
              <Bell className="h-4 w-4" />
              {t("settings.notifications.label")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("settings.notifications.description")}
            </p>
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
          data-tour-id="settings-capture-sources"
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

        <div
          className="flex items-center justify-between p-4 rounded-lg border"
          data-tour-id="settings-theme"
        >
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

        <div
          className="flex items-center justify-between p-4 rounded-lg border"
          data-tour-id="settings-replay-onboarding"
        >
          <div className="space-y-0.5">
            <Label className="flex items-center gap-2">
              <Sparkles className="h-4 w-4" />
              {t("onboarding.replay.label")}
            </Label>
            <p className="text-sm text-muted-foreground">{t("onboarding.replay.description")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleReplayOnboarding()}
            disabled={isUpdatingOnboarding}
          >
            {t("onboarding.replay.action")}
          </Button>
        </div>

        <Separator />
        <AppUpdateCard
          status={updateStatus}
          isChecking={isCheckingUpdate}
          isInstalling={isInstallingUpdate}
          isOpeningDownload={isOpeningUpdateDownload}
          onCheckNow={() => void handleCheckUpdate()}
          onRestartAndInstall={() => void handleRestartAndInstall()}
          onOpenDownload={() => void handleOpenUpdateDownload()}
        />
      </div>
    </div>
  );
}
