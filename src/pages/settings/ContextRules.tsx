import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ArrowLeft, Eye, PencilLine, Save } from "lucide-react";

import { useViewTransition } from "@/components/core/view-transition";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { MarkdownContent } from "@/components/core/activity-monitor/MarkdownContent";

import { useUserSettings } from "./hooks/useUserSettings";
import { CONTEXT_RULES_MAX_CHARS } from "@shared/user-settings-types";

const DEFAULT_PLACEHOLDER = `## Context Rules (MUST FOLLOW)

### Output style
- Use concise Chinese.
- Prefer bullet points and short paragraphs.

### Terminology
- Treat "Mnemora" as the product name.
- When referring to screenshot processing, use the term "pipeline".

### Hard constraints
- Do NOT invent URLs, filenames, IDs, or logs.
- If information is not visible in the screenshot, say "not visible".
- IMPORTANT: Never break the required output format (e.g., VLM must output valid JSON only).`;

export default function ContextRulesPage() {
  const { t } = useTranslation();
  const { navigate } = useViewTransition();
  const { settings, updateSettingsAsync, isUpdating } = useUserSettings();

  const [enabledDraft, setEnabledDraft] = useState<boolean>(settings.contextRulesEnabled);
  const [markdownDraft, setMarkdownDraft] = useState<string>(settings.contextRulesMarkdown);

  const lastSyncedRef = useRef({
    enabled: settings.contextRulesEnabled,
    markdown: settings.contextRulesMarkdown,
    updatedAt: settings.contextRulesUpdatedAt,
  });

  useEffect(() => {
    const nextSynced = {
      enabled: settings.contextRulesEnabled,
      markdown: settings.contextRulesMarkdown,
      updatedAt: settings.contextRulesUpdatedAt,
    };

    const lastSynced = lastSyncedRef.current;
    const settingsChanged =
      nextSynced.enabled !== lastSynced.enabled ||
      nextSynced.markdown !== lastSynced.markdown ||
      nextSynced.updatedAt !== lastSynced.updatedAt;

    if (!settingsChanged) return;

    const hasLocalChanges =
      enabledDraft !== lastSynced.enabled || markdownDraft !== lastSynced.markdown;

    if (!hasLocalChanges) {
      setEnabledDraft(nextSynced.enabled);
      setMarkdownDraft(nextSynced.markdown);
      lastSyncedRef.current = nextSynced;
      return;
    }

    if (enabledDraft === nextSynced.enabled && markdownDraft === nextSynced.markdown) {
      lastSyncedRef.current = nextSynced;
    }
  }, [
    enabledDraft,
    markdownDraft,
    settings.contextRulesEnabled,
    settings.contextRulesMarkdown,
    settings.contextRulesUpdatedAt,
  ]);

  const remainingChars = CONTEXT_RULES_MAX_CHARS - markdownDraft.length;
  const isTooLong = remainingChars < 0;

  const isDirty =
    enabledDraft !== settings.contextRulesEnabled ||
    markdownDraft !== settings.contextRulesMarkdown;

  const lastUpdatedText = useMemo(() => {
    if (!settings.contextRulesUpdatedAt) return null;
    try {
      return new Date(settings.contextRulesUpdatedAt).toLocaleString();
    } catch {
      return null;
    }
  }, [settings.contextRulesUpdatedAt]);

  const handleReset = useCallback(() => {
    setEnabledDraft(settings.contextRulesEnabled);
    setMarkdownDraft(settings.contextRulesMarkdown);
  }, [settings.contextRulesEnabled, settings.contextRulesMarkdown]);

  const handleSave = useCallback(async () => {
    if (isTooLong) {
      toast.error(t("contextRules.errors.tooLong", "Rules are too long"));
      return;
    }

    try {
      await updateSettingsAsync({
        contextRulesEnabled: enabledDraft,
        contextRulesMarkdown: markdownDraft,
      });
      toast.success(t("contextRules.messages.saved", "Saved"));
    } catch (error) {
      toast.error(t("contextRules.messages.saveFailed", "Failed to save"), {
        description: error instanceof Error ? error.message : undefined,
      });
    }
  }, [enabledDraft, isTooLong, markdownDraft, t, updateSettingsAsync]);

  return (
    <div className="max-w-4xl mx-auto space-y-6 pb-10">
      <div className="flex items-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/settings", { type: "slide-right", duration: 300 })}
          disabled={isUpdating}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-3xl font-bold truncate">
            {t("contextRules.title", "Context Rules")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t(
              "contextRules.description",
              "Add markdown rules that will be injected into screenshot-processing prompts"
            )}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleReset}
            disabled={!isDirty || isUpdating}
          >
            {t("contextRules.buttons.reset", "Reset")}
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!isDirty || isTooLong || isUpdating}>
            <Save className="h-4 w-4 mr-2" />
            {t("contextRules.buttons.save", "Save")}
          </Button>
        </div>
      </div>

      <Alert>
        <AlertDescription>
          {t(
            "contextRules.warning",
            "These rules are treated as strong constraints, but required output formats (e.g., JSON-only schemas) must still be followed."
          )}
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="text-lg">{t("contextRules.enable.title", "Enable")}</CardTitle>
              <CardDescription>
                {t(
                  "contextRules.enable.description",
                  "When enabled, rules will be appended to screenshot-processing system prompts."
                )}
                {lastUpdatedText ? (
                  <span className="block mt-1">
                    {t("contextRules.lastUpdated", "Last updated")}: {lastUpdatedText}
                  </span>
                ) : null}
              </CardDescription>
            </div>
            <Switch
              checked={enabledDraft}
              onCheckedChange={setEnabledDraft}
              disabled={isUpdating}
            />
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <Tabs defaultValue="edit" className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="edit" disabled={isUpdating}>
                <PencilLine className="h-4 w-4 mr-2" />
                {t("contextRules.tabs.edit", "Edit")}
              </TabsTrigger>
              <TabsTrigger value="preview" disabled={isUpdating}>
                <Eye className="h-4 w-4 mr-2" />
                {t("contextRules.tabs.preview", "Preview")}
              </TabsTrigger>
            </TabsList>

            <TabsContent value="edit" className="mt-4 space-y-2">
              <div className="flex items-center justify-between">
                <Label>{t("contextRules.editor.label", "Markdown")}</Label>
                <span
                  className={`text-xs ${isTooLong ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {t("contextRules.editor.characters", "Characters")}: {markdownDraft.length}/
                  {CONTEXT_RULES_MAX_CHARS}
                </span>
              </div>
              <Textarea
                value={markdownDraft}
                onChange={(e) => setMarkdownDraft(e.target.value)}
                placeholder={t("contextRules.editor.placeholder", DEFAULT_PLACEHOLDER)}
                className="min-h-[360px] font-mono"
                disabled={isUpdating}
              />
              {isTooLong ? (
                <p className="text-sm text-destructive">
                  {t(
                    "contextRules.errors.tooLongDetailed",
                    "Please keep rules within {{max}} characters.",
                    { max: CONTEXT_RULES_MAX_CHARS }
                  )}
                </p>
              ) : null}
            </TabsContent>

            <TabsContent value="preview" className="mt-4">
              <div className="rounded-lg border p-4 bg-background">
                <MarkdownContent
                  content={markdownDraft.trim() || t("contextRules.preview.empty", "(empty)")}
                />
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
