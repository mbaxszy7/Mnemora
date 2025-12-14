import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import type { AppInfo } from "@shared/capture-source-types";
import { findPopularApp } from "@shared/popular-apps";
import { AppWindow } from "lucide-react";

/**
 * Convert SVG string to data URL for use in img src
 */
function svgToDataUrl(svg: string): string {
  const normalized = svg.replace(/\r?\n|\r/g, "").trim();
  const encoded = encodeURIComponent(normalized).replace(/'/g, "%27").replace(/"/g, "%22");
  return `data:image/svg+xml,${encoded}`;
}

/**
 * Get icon data URL for an app name using findPopularApp
 */
function getAppIcon(appName: string): string | null {
  const popularApp = findPopularApp(appName);
  if (popularApp?.config.simpleIcon?.svg) {
    return svgToDataUrl(popularApp.config.simpleIcon.svg);
  }
  return null;
}

export interface AppItemProps {
  app: AppInfo;
  isSelected: boolean;
  onToggle: (appName: string) => void;
}

/**
 * AppItem component displays an application with icon, name, window count,
 * and checkbox selection interaction.
 *
 * Requirements: 2.2, 2.3, 2.5
 */
export function AppItem({ app, isSelected, onToggle }: AppItemProps) {
  // Compute icon from popular apps on frontend
  const icon = useMemo(() => getAppIcon(app.name), [app.name]);

  const handleClick = () => {
    onToggle(app.name);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(app.name);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all",
        "hover:bg-accent/50",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        isSelected ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      {/* Checkbox */}
      <Checkbox
        checked={isSelected}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => onToggle(app.name)}
      />

      {/* App icon */}
      <div className="shrink-0 w-8 h-8 flex items-center justify-center">
        {icon ? (
          <img src={icon} alt={app.name} className="w-8 h-8 object-contain" />
        ) : (
          <AppWindow className="w-6 h-6 text-muted-foreground" />
        )}
      </div>

      {/* App name */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm truncate" title={app.name}>
            {app.name}
          </span>
        </div>
      </div>
    </div>
  );
}
