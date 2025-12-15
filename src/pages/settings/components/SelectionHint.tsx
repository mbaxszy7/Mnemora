import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";

export type SelectionHintType = "screens" | "apps";

export interface SelectionHintProps {
  type: SelectionHintType;
  isVisible: boolean;
}

/**
 * SelectionHint component displays a hint message when no items are selected,
 * indicating that all screens/apps will be captured.
 *
 * Requirements: 6.1, 6.2
 */
export function SelectionHint({ type, isVisible }: SelectionHintProps) {
  const { t } = useTranslation();

  if (!isVisible) {
    return null;
  }

  const messageKey =
    type === "screens"
      ? "captureSourceSettings.screens.allScreensHint"
      : "captureSourceSettings.apps.allAppsHint";

  return (
    <div
      role="alert"
      className="flex items-center gap-2 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground"
    >
      <Info className="h-4 w-4 shrink-0" />
      <span>{t(messageKey)}</span>
    </div>
  );
}
