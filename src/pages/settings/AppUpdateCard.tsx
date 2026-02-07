import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AppUpdateStatus } from "@shared/app-update-types";

interface AppUpdateCardProps {
  status: AppUpdateStatus | null;
  isChecking: boolean;
  isInstalling: boolean;
  isOpeningDownload: boolean;
  onCheckNow: () => void;
  onRestartAndInstall: () => void;
  onOpenDownload: () => void;
}

export function AppUpdateCard(props: AppUpdateCardProps) {
  const { t } = useTranslation();
  const {
    status,
    isChecking,
    isInstalling,
    isOpeningDownload,
    onCheckNow,
    onRestartAndInstall,
    onOpenDownload,
  } = props;

  return (
    <div className="rounded-lg border p-4 space-y-4">
      <div className="space-y-0.5">
        <Label className="flex items-center gap-2">
          <Download className="h-4 w-4" />
          {t("settings.updates.title")}
        </Label>
        <p className="text-sm text-muted-foreground">{t("settings.updates.description")}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
        <div>
          <span className="text-muted-foreground">{t("settings.updates.currentVersion")} </span>
          <span className="font-medium">{status?.currentVersion ?? "-"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{t("settings.updates.availableVersion")} </span>
          <span className="font-medium">{status?.availableVersion ?? "-"}</span>
        </div>
        <div>
          <span className="text-muted-foreground">{t("settings.updates.channel")} </span>
          <span className="font-medium">
            {t(`settings.updates.channels.${status?.channel ?? "stable"}`)}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">{t("settings.updates.statusLabel")} </span>
          <span className="font-medium">
            {t(`settings.updates.status.${status?.phase ?? "idle"}`)}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">{t("settings.updates.lastCheckedAt")} </span>
          <span className="font-medium">
            {status?.lastCheckedAt
              ? new Date(status.lastCheckedAt).toLocaleString()
              : t("settings.updates.never")}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={onCheckNow} disabled={isChecking}>
          <RefreshCw className="h-4 w-4 mr-2" />
          {isChecking
            ? t("settings.updates.actions.checking")
            : t("settings.updates.actions.checkNow")}
        </Button>

        {status?.platformAction === "restart-and-install" && (
          <Button size="sm" onClick={onRestartAndInstall} disabled={isInstalling}>
            {isInstalling
              ? t("settings.updates.actions.installing")
              : t("settings.updates.actions.restartToUpdate")}
          </Button>
        )}

        {status?.platformAction === "open-download-page" && (
          <Button
            size="sm"
            variant="secondary"
            onClick={onOpenDownload}
            disabled={isOpeningDownload}
          >
            {isOpeningDownload
              ? t("settings.updates.actions.opening")
              : t("settings.updates.actions.downloadLatest")}
          </Button>
        )}
      </div>
    </div>
  );
}
