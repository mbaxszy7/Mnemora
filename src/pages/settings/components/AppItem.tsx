import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import type { AppInfo } from "@shared/capture-source-types";
import { formatAppName } from "@shared/popular-apps";
import { AppWindow } from "lucide-react";

export interface AppItemProps {
  app: AppInfo;
  isSelected: boolean;
  onToggle: (appId: string) => void;
}

/**
 * AppItem component displays an application with icon, name, window count,
 * and checkbox selection interaction.
 *
 * Requirements: 2.2, 2.3, 2.5
 */
export function AppItem({ app, isSelected, onToggle }: AppItemProps) {
  const handleClick = () => {
    onToggle(app.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(app.id);
    }
  };

  const appName = formatAppName(app.name);
  const showSubtitle = app.name !== appName;

  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        "flex items-center gap-3 p-3 cursor-pointer transition-all border",
        "hover:bg-accent/50 hover:shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        isSelected ? "border-primary bg-primary/5" : "border-border"
      )}
    >
      {/* Checkbox */}
      <Checkbox
        checked={isSelected}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={() => onToggle(app.id)}
      />

      {/* App icon */}
      <div className="shrink-0 w-8 h-8 flex items-center justify-center bg-muted/20 rounded-md">
        {app.appIcon ? (
          <img src={app.appIcon} alt={app.name} className="w-full h-full object-contain" />
        ) : (
          <AppWindow className="w-5 h-5 text-muted-foreground" />
        )}
      </div>

      {/* App name */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-col">
          <span className="font-medium text-sm truncate" title={appName}>
            {appName}
          </span>
          {showSubtitle && (
            <span className="text-xs text-muted-foreground truncate" title={app.name}>
              {app.name}
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
