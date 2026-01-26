import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { ScreenInfo } from "@shared/capture-source-types";
import { useTranslation } from "react-i18next";

export interface ScreenCardProps {
  screen: ScreenInfo;
  isSelected: boolean;
  onToggle: (screenId: string) => void;
  disabled?: boolean;
}

/**
 * ScreenCard component displays a screen with thumbnail, name, resolution,
 * and primary display indicator. Supports selection interaction.
 */
export function ScreenCard({ screen, isSelected, onToggle, disabled = false }: ScreenCardProps) {
  const { t } = useTranslation();

  const handleClick = () => {
    if (disabled) return;
    onToggle(screen.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(screen.id);
    }
  };

  return (
    <Card
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "relative overflow-hidden cursor-pointer transition-all border-2",
        disabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/50 hover:shadow-md",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        isSelected ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      {/* Thumbnail */}
      <div className="aspect-video bg-muted relative">
        {screen.thumbnail ? (
          <img src={screen.thumbnail} alt={screen.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground">
            <span className="text-sm">{t("common.messages.loading")}</span>
          </div>
        )}

        {/* Selection checkbox overlay */}
        <div className="absolute top-2 right-2">
          <Checkbox
            checked={isSelected}
            className="bg-background/80 backdrop-blur-sm border-primary"
            onClick={(e) => e.stopPropagation()}
            onCheckedChange={() => {
              if (disabled) return;
              onToggle(screen.id);
            }}
            disabled={disabled}
          />
        </div>

        {/* Primary badge */}
        {screen.isPrimary && (
          <div className="absolute top-2 left-2">
            <Badge
              variant="secondary"
              className="bg-background/80 backdrop-blur-sm text-xs shadow-sm"
            >
              {t("captureSourceSettings.screens.primary", "Primary")}
            </Badge>
          </div>
        )}
      </div>

      {/* Info section */}
      <div className="p-3 space-y-1">
        <div className="font-medium text-sm truncate" title={screen.name}>
          {screen.name}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <span>{t("captureSourceSettings.screens.resolution", "Resolution")}:</span>
          <span>
            {screen.bounds.width} × {screen.bounds.height}
          </span>
        </div>
      </div>
    </Card>
  );
}
