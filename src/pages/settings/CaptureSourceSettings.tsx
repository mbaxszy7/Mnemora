import { Suspense, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft } from "lucide-react";
import { useViewTransition } from "@/components/core/view-transition";
import { ScreenSelector, AppSelector } from "./components";
import { useCaptureScreens } from "./hooks/useCaptureScreens";
import { useCaptureApps } from "./hooks/useCaptureApps";
import { useCapturePreferences } from "./hooks/useCapturePreferences";

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
  const screensQuery = useCaptureScreens();
  const appsQuery = useCaptureApps();
  const { preferences, updatePreferences } = useCapturePreferences();

  const screens = useMemo(
    () => screensQuery.data?.data?.screens ?? [],
    [screensQuery.data?.data?.screens]
  );
  const apps = useMemo(() => appsQuery.data?.data?.apps ?? [], [appsQuery.data?.data?.apps]);

  const selectedScreenIds = useMemo(
    () => preferences?.selectedScreenIds ?? [],
    [preferences?.selectedScreenIds]
  );
  const selectedAppNames = useMemo(
    () => preferences?.selectedAppNames ?? [],
    [preferences?.selectedAppNames]
  );

  // Screen selection handlers
  const handleToggleScreen = useCallback(
    (screenId: string) => {
      const newSelectedIds = selectedScreenIds.includes(screenId)
        ? selectedScreenIds.filter((id) => id !== screenId)
        : [...selectedScreenIds, screenId];
      updatePreferences({ selectedScreenIds: newSelectedIds });
    },
    [selectedScreenIds, updatePreferences]
  );

  const handleSelectAllScreens = useCallback(() => {
    updatePreferences({ selectedScreenIds: screens.map((s) => s.id) });
  }, [screens, updatePreferences]);

  const handleDeselectAllScreens = useCallback(() => {
    updatePreferences({ selectedScreenIds: [] });
  }, [updatePreferences]);

  // App selection handlers
  const handleToggleApp = useCallback(
    (appName: string) => {
      const newSelectedNames = selectedAppNames.includes(appName)
        ? selectedAppNames.filter((name) => name !== appName)
        : [...selectedAppNames, appName];
      updatePreferences({ selectedAppNames: newSelectedNames });
    },
    [selectedAppNames, updatePreferences]
  );

  const handleSelectAllApps = useCallback(() => {
    updatePreferences({ selectedAppNames: apps.map((a) => a.name) });
  }, [apps, updatePreferences]);

  const handleDeselectAllApps = useCallback(() => {
    updatePreferences({ selectedAppNames: [] });
  }, [updatePreferences]);

  return (
    <div className="space-y-8">
      {/* Screen Selector */}
      <ScreenSelector
        screens={screens}
        selectedScreenIds={selectedScreenIds}
        onToggleScreen={handleToggleScreen}
        onSelectAll={handleSelectAllScreens}
        onDeselectAll={handleDeselectAllScreens}
      />

      {/* App Selector */}
      <AppSelector
        apps={apps}
        selectedAppNames={selectedAppNames}
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
 *
 * Requirements: 1.1, 2.1
 */
export default function CaptureSourceSettings() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();

  const handleBack = useCallback(() => {
    navigate("/settings", { type: "slide-right", duration: 300 });
  }, [navigate]);

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header with back button */}
      <div className="space-y-2">
        <Button variant="ghost" size="sm" onClick={handleBack} className="mb-2">
          <ArrowLeft className="mr-2 h-4 w-4" />
          {t("settings.title", "Settings")}
        </Button>
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
      </div>

      {/* Content with Suspense boundary */}
      <Suspense fallback={<CaptureSourceSettingsSkeleton />}>
        <CaptureSourceSettingsContent />
      </Suspense>
    </div>
  );
}
