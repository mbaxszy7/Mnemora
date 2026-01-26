import { Suspense, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { ArrowLeft, Loader2, RotateCw } from "lucide-react";
import { useViewTransition } from "@/components/core/view-transition";
import { ScreenSelector, AppSelector } from "./components";
import { CAPTURE_SCREENS_QUERY_KEY, useCaptureScreens } from "./hooks/useCaptureScreens";
import { CAPTURE_APPS_QUERY_KEY, useCaptureApps } from "./hooks/useCaptureApps";
import {
  CAPTURE_PREFERENCES_QUERY_KEY,
  useCapturePreferences,
} from "./hooks/useCapturePreferences";
import { USER_SETTINGS_QUERY_KEY, useUserSettings } from "./hooks/useUserSettings";
import { useQueryClient } from "@tanstack/react-query";
import type { CaptureAllowedWindow } from "@shared/user-settings-types";
import { timeStringToMinutes } from "@shared/user-settings-utils";

const TIME_STEP_MINUTES = 5;

const TIME_OPTIONS: string[] = (() => {
  const times: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += TIME_STEP_MINUTES) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    times.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
  return times;
})();

const TIME_OPTIONS_WITH_MINUTES = TIME_OPTIONS.map((time) => ({
  time,
  minutes: timeStringToMinutes(time) ?? 0,
}));

const TIME_INDEX = new Map<string, number>(TIME_OPTIONS.map((time, idx) => [time, idx]));

function getNextTime(value: string): string | null {
  const idx = TIME_INDEX.get(value);
  if (idx == null) return null;
  return TIME_OPTIONS[idx + 1] ?? null;
}

function getPrevTime(value: string): string | null {
  const idx = TIME_INDEX.get(value);
  if (idx == null) return null;
  return TIME_OPTIONS[idx - 1] ?? null;
}

/**
 * Loading skeleton for the capture source settings page
 */
function CaptureSourceSettingsSkeleton() {
  return (
    <div className="space-y-8">
      {/* Screens section skeleton */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-24" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-48 rounded-lg" />
          ))}
        </div>
      </div>

      <Separator />

      {/* Apps section skeleton */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-28" />
          <div className="flex gap-2">
            <Skeleton className="h-9 w-24" />
            <Skeleton className="h-9 w-28" />
          </div>
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-14 rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Inner content component that uses Suspense-enabled hooks
 */
function CaptureSourceSettingsContent() {
  const { t } = useTranslation();
  const screensQuery = useCaptureScreens();
  const appsQuery = useCaptureApps();
  const { preferences, updatePreferences } = useCapturePreferences();
  const { settings, updateSettings, isUpdating } = useUserSettings();

  const [draftAllowedWindows, setDraftAllowedWindows] = useState<CaptureAllowedWindow[] | null>(
    null
  );

  const screens = useMemo(
    () => screensQuery.data?.data?.screens ?? [],
    [screensQuery.data?.data?.screens]
  );
  const apps = useMemo(() => appsQuery.data?.data?.apps ?? [], [appsQuery.data?.data?.apps]);

  const selectedScreens = useMemo(
    () => preferences?.selectedScreens ?? [],
    [preferences?.selectedScreens]
  );
  const selectedApps = useMemo(() => preferences?.selectedApps ?? [], [preferences?.selectedApps]);

  const allowedWindows = useMemo(
    () => draftAllowedWindows ?? settings.captureAllowedWindows,
    [draftAllowedWindows, settings.captureAllowedWindows]
  );

  const isAllowedWindowsValid = useMemo(() => {
    for (const w of allowedWindows) {
      const start = timeStringToMinutes(w.start);
      const end = timeStringToMinutes(w.end);
      if (start == null || end == null) return false;
      if (end <= start) return false;
    }
    return true;
  }, [allowedWindows]);

  const handleTogglePrimaryOnly = useCallback(
    (checked: boolean) => {
      updateSettings({ capturePrimaryScreenOnly: checked });
    },
    [updateSettings]
  );

  const handleToggleScheduleEnabled = useCallback(
    (checked: boolean) => {
      updateSettings({ captureScheduleEnabled: checked });
    },
    [updateSettings]
  );

  const handleAddAllowedWindow = useCallback(() => {
    setDraftAllowedWindows((prev) => {
      const base = prev ?? settings.captureAllowedWindows;
      return [...base, { start: "10:00", end: "12:00" }];
    });
  }, [settings.captureAllowedWindows]);

  const handleRemoveAllowedWindow = useCallback(
    (index: number) => {
      setDraftAllowedWindows((prev) => {
        const base = prev ?? settings.captureAllowedWindows;
        return base.filter((_w, i) => i !== index);
      });
    },
    [settings.captureAllowedWindows]
  );

  const handleChangeAllowedWindow = useCallback(
    (index: number, patch: Partial<CaptureAllowedWindow>) => {
      setDraftAllowedWindows((prev) => {
        const base = prev ?? settings.captureAllowedWindows;
        return base.map((w, i) => {
          if (i !== index) return w;

          const updated: CaptureAllowedWindow = { ...w, ...patch };
          const startMinutes = timeStringToMinutes(updated.start);
          const endMinutes = timeStringToMinutes(updated.end);
          if (startMinutes == null || endMinutes == null) return updated;
          if (endMinutes > startMinutes) return updated;

          if (patch.start != null) {
            const nextEnd = getNextTime(updated.start);
            return nextEnd ? { ...updated, end: nextEnd } : updated;
          }

          if (patch.end != null) {
            const prevStart = getPrevTime(updated.end);
            return prevStart ? { ...updated, start: prevStart } : updated;
          }

          return updated;
        });
      });
    },
    [settings.captureAllowedWindows]
  );

  const handleSaveAllowedWindows = useCallback(() => {
    if (!settings.captureScheduleEnabled) return;
    if (!isAllowedWindowsValid) return;
    updateSettings(
      { captureAllowedWindows: allowedWindows },
      {
        onSuccess: () => {
          setDraftAllowedWindows(null);
        },
      }
    );
  }, [allowedWindows, isAllowedWindowsValid, settings.captureScheduleEnabled, updateSettings]);

  // Screen selection handlers
  const handleToggleScreen = useCallback(
    (screenId: string) => {
      const isSelected = selectedScreens.some((s) => s.id === screenId);
      if (isSelected) {
        const newSelectedScreens = selectedScreens.filter((s) => s.id !== screenId);
        updatePreferences({ selectedScreens: newSelectedScreens });
      } else {
        const screenToAdd = screens.find((s) => s.id === screenId);
        if (screenToAdd) {
          // Clear apps when selecting screen (mutually exclusive)
          updatePreferences({
            selectedScreens: [...selectedScreens, screenToAdd],
            selectedApps: [],
          });
        }
      }
    },
    [screens, selectedScreens, updatePreferences]
  );

  const handleSelectAllScreens = useCallback(() => {
    // Clear apps when selecting screens (mutually exclusive)
    updatePreferences({ selectedScreens: screens, selectedApps: [] });
  }, [screens, updatePreferences]);

  const handleDeselectAllScreens = useCallback(() => {
    updatePreferences({ selectedScreens: [] });
  }, [updatePreferences]);

  // App selection handlers
  const handleToggleApp = useCallback(
    (appId: string) => {
      const isSelected = selectedApps.some((app) => app.id === appId);
      if (isSelected) {
        const newSelectedApps = selectedApps.filter((app) => app.id !== appId);
        updatePreferences({ selectedApps: newSelectedApps });
      } else {
        const appToAdd = apps.find((app) => app.id === appId);
        if (appToAdd) {
          // Clear screens when selecting app (mutually exclusive)
          updatePreferences({ selectedApps: [...selectedApps, appToAdd], selectedScreens: [] });
        }
      }
    },
    [apps, selectedApps, updatePreferences]
  );

  const handleSelectAllApps = useCallback(() => {
    // Clear screens when selecting apps (mutually exclusive)
    updatePreferences({ selectedApps: apps, selectedScreens: [] });
  }, [apps, updatePreferences]);

  const handleDeselectAllApps = useCallback(() => {
    updatePreferences({ selectedApps: [] });
  }, [updatePreferences]);

  return (
    <div className="space-y-8">
      <Card>
        <CardHeader>
          <CardTitle>{t("captureSourceSettings.behavior.title", "Capture behavior")}</CardTitle>
          <CardDescription>
            {t(
              "captureSourceSettings.behavior.allowedWindows.description",
              "Capture will run only during these times when schedule is enabled"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="leading-none">
                {t(
                  "captureSourceSettings.behavior.primaryOnly.label",
                  "Capture primary screen only"
                )}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t(
                  "captureSourceSettings.behavior.primaryOnly.description",
                  "Only capture the primary display when capturing screens"
                )}
              </p>
            </div>
            <Switch
              checked={settings.capturePrimaryScreenOnly}
              onCheckedChange={handleTogglePrimaryOnly}
              disabled={isUpdating}
            />
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label className="leading-none">
                {t("captureSourceSettings.behavior.scheduleEnabled.label", "Use capture schedule")}
              </Label>
              <p className="text-sm text-muted-foreground">
                {t(
                  "captureSourceSettings.behavior.scheduleEnabled.description",
                  "Automatically pause capture outside your allowed time windows"
                )}
              </p>
            </div>
            <Switch
              checked={settings.captureScheduleEnabled}
              onCheckedChange={handleToggleScheduleEnabled}
              disabled={isUpdating}
            />
          </div>

          <div className="space-y-2">
            <div className="space-y-1">
              <Label className="leading-none">
                {t("captureSourceSettings.behavior.allowedWindows.title", "Allowed time windows")}
              </Label>
            </div>

            <div className="space-y-2">
              {allowedWindows.map((w, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  {(() => {
                    const startMinutes = timeStringToMinutes(w.start);
                    const endMinutes = timeStringToMinutes(w.end);

                    const startCandidates = TIME_OPTIONS_WITH_MINUTES.slice(0, -1);
                    const endCandidates = TIME_OPTIONS_WITH_MINUTES.slice(1);

                    const startOptions = startCandidates
                      .filter(({ minutes }) => (endMinutes == null ? true : minutes < endMinutes))
                      .map(({ time }) => time);

                    const endOptions = endCandidates
                      .filter(({ minutes }) =>
                        startMinutes == null ? true : minutes > startMinutes
                      )
                      .map(({ time }) => time);

                    return (
                      <div className="grid grid-cols-2 gap-2 flex-1">
                        <Select
                          value={w.start}
                          onValueChange={(value) =>
                            handleChangeAllowedWindow(idx, { start: value })
                          }
                          disabled={!settings.captureScheduleEnabled || isUpdating}
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t(
                                "captureSourceSettings.behavior.allowedWindows.start",
                                "Start"
                              )}
                            />
                          </SelectTrigger>
                          <SelectContent className="max-h-[260px]">
                            {startOptions.map((time) => (
                              <SelectItem key={time} value={time}>
                                {time}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Select
                          value={w.end}
                          onValueChange={(value) => handleChangeAllowedWindow(idx, { end: value })}
                          disabled={!settings.captureScheduleEnabled || isUpdating}
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={t(
                                "captureSourceSettings.behavior.allowedWindows.end",
                                "End"
                              )}
                            />
                          </SelectTrigger>
                          <SelectContent className="max-h-[260px]">
                            {endOptions.map((time) => (
                              <SelectItem key={time} value={time}>
                                {time}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })()}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRemoveAllowedWindow(idx)}
                    disabled={!settings.captureScheduleEnabled || isUpdating}
                  >
                    {t("captureSourceSettings.behavior.allowedWindows.remove", "Remove")}
                  </Button>
                </div>
              ))}
            </div>

            {!isAllowedWindowsValid && settings.captureScheduleEnabled ? (
              <div className="text-sm text-destructive">
                {t(
                  "captureSourceSettings.behavior.allowedWindows.invalid",
                  "End time must be later than start time"
                )}
              </div>
            ) : null}

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleAddAllowedWindow}
                disabled={!settings.captureScheduleEnabled || isUpdating}
              >
                {t("captureSourceSettings.behavior.allowedWindows.add", "Add window")}
              </Button>
              <Button
                size="sm"
                onClick={handleSaveAllowedWindows}
                disabled={
                  !settings.captureScheduleEnabled ||
                  draftAllowedWindows == null ||
                  !isAllowedWindowsValid ||
                  isUpdating
                }
              >
                {t("captureSourceSettings.behavior.allowedWindows.save", "Save")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Separator />

      {/* Screen Selector */}
      <ScreenSelector
        screens={screens}
        selectedScreens={selectedScreens}
        onToggleScreen={handleToggleScreen}
        onSelectAll={handleSelectAllScreens}
        onDeselectAll={handleDeselectAllScreens}
        selectionDisabled={settings.capturePrimaryScreenOnly}
      />

      <Separator />

      {/* App Selector */}
      <AppSelector
        apps={apps}
        selectedApps={selectedApps}
        onToggleApp={handleToggleApp}
        onSelectAll={handleSelectAllApps}
        onDeselectAll={handleDeselectAllApps}
      />
    </div>
  );
}

/**
 * CaptureSourceSettings page component
 *
 * Allows users to configure which screens and applications to capture.
 * Combines ScreenSelector and AppSelector components.
 * Preferences are session-level only and reset when app restarts.
 */
export default function CaptureSourceSettings() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const screensQuery = useCaptureScreens();
  const appsQuery = useCaptureApps();
  const queryClient = useQueryClient();
  const handleBack = useCallback(() => {
    navigate("/settings", { type: "slide-right", duration: 300 });
  }, [navigate]);

  const handleReload = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: CAPTURE_SCREENS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: CAPTURE_APPS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: CAPTURE_PREFERENCES_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: USER_SETTINGS_QUERY_KEY }),
    ]);
  }, [queryClient]);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header with back button */}
      <div className="space-y-2">
        <Button variant="ghost" size="sm" onClick={handleBack} className="mb-2">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("settings.title", "Settings")}
        </Button>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-3xl font-bold">
              {t("captureSourceSettings.title", "Capture Source Settings")}
            </h1>
            <p className="text-muted-foreground mt-2">
              {t(
                "captureSourceSettings.description",
                "Configure which screens and applications to capture"
              )}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={handleReload}
            className="gap-2"
            disabled={screensQuery.isFetching || appsQuery.isFetching}
          >
            {screensQuery.isFetching || appsQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RotateCw className="h-4 w-4" />
            )}
            {t("common.buttons.reload", "Reload")}
          </Button>
        </div>
      </div>

      {/* Content with Suspense boundary */}
      <Suspense fallback={<CaptureSourceSettingsSkeleton />}>
        <CaptureSourceSettingsContent />
      </Suspense>
    </div>
  );
}
