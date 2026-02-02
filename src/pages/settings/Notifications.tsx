import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bell, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useViewTransition } from "@/components/core/view-transition";

import { useNotificationPreferences } from "./hooks/useNotificationPreferences";

export default function NotificationsPage() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const { preferences, updatePreferencesAsync, isUpdating } = useNotificationPreferences();

  const [draft, setDraft] = useState(preferences);
  const lastSyncedRef = useRef(preferences);

  useEffect(() => {
    const last = lastSyncedRef.current;
    const changed = JSON.stringify(last) !== JSON.stringify(preferences);
    if (!changed) return;

    const hasLocalChanges = JSON.stringify(draft) !== JSON.stringify(last);
    if (!hasLocalChanges) {
      setDraft(preferences);
      lastSyncedRef.current = preferences;
      return;
    }

    if (JSON.stringify(draft) === JSON.stringify(preferences)) {
      lastSyncedRef.current = preferences;
    }
  }, [draft, preferences]);

  const isDirty = JSON.stringify(draft) !== JSON.stringify(preferences);

  const handleSave = useCallback(async () => {
    try {
      await updatePreferencesAsync(draft);
      toast.success(t("notificationsPage.messages.saved", "Saved"));
    } catch (error) {
      toast.error(t("notificationsPage.messages.saveFailed", "Failed to save"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }, [draft, t, updatePreferencesAsync]);

  return (
    <div className="max-w-3xl mx-auto space-y-6 pb-10">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/settings", { type: "slide-right", duration: 300 })}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6" />
            {t("notificationsPage.title", "Notifications")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t("notificationsPage.description", "Choose which notifications you want to receive")}
          </p>
        </div>
        <div className="ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || isUpdating}
          >
            <Save className="h-4 w-4 mr-2" />
            {t("common.buttons.save", "Save")}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("notificationsPage.global.title", "Global")}</CardTitle>
          <CardDescription>
            {t("notificationsPage.global.description", "Enable or disable notifications")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.global.enabled", "Enable notifications")}</Label>
            </div>
            <Switch
              checked={draft.enabled}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, enabled: v }))}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.global.sound", "Sound")}</Label>
              <p className="text-sm text-muted-foreground">
                {t(
                  "notificationsPage.global.soundDescription",
                  "Play a sound when showing notifications"
                )}
              </p>
            </div>
            <Switch
              checked={draft.soundEnabled}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, soundEnabled: v }))}
              disabled={!draft.enabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("notificationsPage.types.title", "Types")}</CardTitle>
          <CardDescription>
            {t("notificationsPage.types.description", "Toggle notification categories")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.types.activitySummary", "Activity summary")}</Label>
            </div>
            <Switch
              checked={draft.activitySummary}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, activitySummary: v }))}
              disabled={!draft.enabled}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.types.llmErrors", "LLM errors")}</Label>
            </div>
            <Switch
              checked={draft.llmErrors}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, llmErrors: v }))}
              disabled={!draft.enabled}
            />
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.types.capturePaused", "Capture paused")}</Label>
            </div>
            <Switch
              checked={draft.capturePaused}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, capturePaused: v }))}
              disabled={!draft.enabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("notificationsPage.dnd.title", "Do Not Disturb")}</CardTitle>
          <CardDescription>
            {t("notificationsPage.dnd.description", "Suppress notifications during a time window")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label>{t("notificationsPage.dnd.enabled", "Enable Do Not Disturb")}</Label>
            </div>
            <Switch
              checked={draft.doNotDisturb}
              onCheckedChange={(v) => setDraft((p) => ({ ...p, doNotDisturb: v }))}
              disabled={!draft.enabled}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t("notificationsPage.dnd.from", "From")}</Label>
              <Input
                value={draft.doNotDisturbFrom}
                onChange={(e) => setDraft((p) => ({ ...p, doNotDisturbFrom: e.target.value }))}
                placeholder="22:00"
                disabled={!draft.enabled || !draft.doNotDisturb}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("notificationsPage.dnd.to", "To")}</Label>
              <Input
                value={draft.doNotDisturbTo}
                onChange={(e) => setDraft((p) => ({ ...p, doNotDisturbTo: e.target.value }))}
                placeholder="08:00"
                disabled={!draft.enabled || !draft.doNotDisturb}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
