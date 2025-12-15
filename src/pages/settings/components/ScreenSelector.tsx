import { Button } from "@/components/ui/button";
import { ScreenCard } from "./ScreenCard";
import { SelectionHint } from "./SelectionHint";
import type { ScreenInfo } from "@shared/capture-source-types";
import { CheckSquare, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ScreenSelectorProps {
  screens: ScreenInfo[];
  selectedScreens: ScreenInfo[];
  onToggleScreen: (screenId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

/**
 * ScreenSelector component renders a grid of screen cards with
 * select all/deselect all buttons and empty selection hint.
 */
export function ScreenSelector({
  screens,
  selectedScreens,
  onToggleScreen,
  onSelectAll,
  onDeselectAll,
}: ScreenSelectorProps) {
  const { t } = useTranslation();
  const selectedScreenIds = selectedScreens.map((s) => s.id);
  const allSelected = screens.length > 0 && selectedScreens.length === screens.length;
  const noneSelected = selectedScreens.length === 0;

  return (
    <div className="space-y-4">
      {/* Header with title and actions */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">{t("captureSourceSettings.screens.title")}</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSelectAll} disabled={allSelected}>
            <CheckSquare className="h-4 w-4 mr-1" />
            {t("captureSourceSettings.screens.selectAll")}
          </Button>
          <Button variant="outline" size="sm" onClick={onDeselectAll} disabled={noneSelected}>
            <Square className="h-4 w-4 mr-1" />
            {t("captureSourceSettings.screens.deselectAll")}
          </Button>
        </div>
      </div>

      {/* Empty selection hint */}
      <SelectionHint type="screens" isVisible={noneSelected && screens.length > 0} />

      {/* Screen cards grid */}
      {screens.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {screens.map((screen) => (
            <ScreenCard
              key={screen.id}
              screen={screen}
              isSelected={selectedScreenIds.includes(screen.id)}
              onToggle={onToggleScreen}
            />
          ))}
        </div>
      ) : (
        <div className="text-center text-muted-foreground py-8">
          {t("captureSourceSettings.screens.noScreens")}
        </div>
      )}
    </div>
  );
}
