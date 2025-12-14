import { Button } from "@/components/ui/button";
import { ScreenCard } from "./ScreenCard";
import type { ScreenInfo } from "@shared/capture-source-types";
import { CheckSquare, Square } from "lucide-react";

export interface ScreenSelectorProps {
  screens: ScreenInfo[];
  selectedScreenIds: string[];
  onToggleScreen: (screenId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

/**
 * ScreenSelector component renders a grid of screen cards with
 * select all/deselect all buttons and empty selection hint.
 *
 * Requirements: 1.1, 1.4, 6.1, 10.1, 10.2
 */
export function ScreenSelector({
  screens,
  selectedScreenIds,
  onToggleScreen,
  onSelectAll,
  onDeselectAll,
}: ScreenSelectorProps) {
  const allSelected = screens.length > 0 && selectedScreenIds.length === screens.length;
  const noneSelected = selectedScreenIds.length === 0;

  return (
    <div className="space-y-4">
      {/* Header with title and actions */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Screens</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSelectAll} disabled={allSelected}>
            <CheckSquare className="h-4 w-4 mr-1" />
            Select All
          </Button>
          <Button variant="outline" size="sm" onClick={onDeselectAll} disabled={noneSelected}>
            <Square className="h-4 w-4 mr-1" />
            Deselect All
          </Button>
        </div>
      </div>

      {/* Empty selection hint */}
      {noneSelected && screens.length > 0 && (
        <div className="text-sm text-muted-foreground bg-muted/50 rounded-md p-3">
          All screens will be captured
        </div>
      )}

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
        <div className="text-center text-muted-foreground py-8">No screens available</div>
      )}
    </div>
  );
}
