import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppItem } from "./AppItem";
import { SelectionHint } from "./SelectionHint";
import type { AppInfo } from "@shared/capture-source-types";
import { CheckSquare, Square, Search } from "lucide-react";

/** Threshold for showing search functionality */
const SEARCH_THRESHOLD = 10;

export interface AppSelectorProps {
  apps: AppInfo[];
  selectedApps: AppInfo[];
  onToggleApp: (appId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

/**
 * AppSelector component renders a list of applications with
 * search/filter functionality (when apps > 10), select all/deselect all buttons,
 * and empty selection hint.
 */
export function AppSelector({
  apps,
  selectedApps,
  onToggleApp,
  onSelectAll,
  onDeselectAll,
}: AppSelectorProps) {
  const { t } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");

  const selectedAppIds = selectedApps.map((a) => a.id);
  const showSearch = apps.length > SEARCH_THRESHOLD;
  const allSelected = apps.length > 0 && selectedApps.length === apps.length;
  const noneSelected = selectedApps.length === 0;

  // Filter apps based on search query
  const filteredApps = useMemo(() => {
    if (!searchQuery.trim()) {
      return apps;
    }
    const query = searchQuery.toLowerCase().trim();
    return apps.filter((app) => app.name.toLowerCase().includes(query));
  }, [apps, searchQuery]);

  return (
    <div className="space-y-4">
      {/* Header with title and actions */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {t("captureSourceSettings.apps.title", "Select Windows")}
        </h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onSelectAll} disabled={allSelected}>
            <CheckSquare className="h-4 w-4 mr-1" />
            {t("captureSourceSettings.apps.selectAll", "Select All")}
          </Button>
          <Button variant="outline" size="sm" onClick={onDeselectAll} disabled={noneSelected}>
            <Square className="h-4 w-4 mr-1" />
            {t("captureSourceSettings.apps.deselectAll", "Deselect All")}
          </Button>
        </div>
      </div>

      {/* Search input (only shown when apps > SEARCH_THRESHOLD) */}
      {showSearch && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("captureSourceSettings.apps.searchPlaceholder", "Search windows...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      )}

      {/* Empty selection hint */}
      <SelectionHint type="apps" isVisible={noneSelected && apps.length > 0} />

      {/* App list */}
      {filteredApps.length > 0 ? (
        <div className="space-y-2 max-h-[400px] overflow-y-auto pr-1">
          {filteredApps.map((app) => (
            <AppItem
              key={app.id}
              app={app}
              isSelected={selectedAppIds.includes(app.id)}
              onToggle={onToggleApp}
            />
          ))}
        </div>
      ) : apps.length > 0 ? (
        <div className="text-center text-muted-foreground py-8">
          {t("captureSourceSettings.apps.noResults", "No windows found")}
        </div>
      ) : (
        <div className="text-center text-muted-foreground py-8">
          {t("captureSourceSettings.apps.noApps", "No windows available")}
        </div>
      )}
    </div>
  );
}

/**
 * Export the search threshold for testing purposes
 */
export { SEARCH_THRESHOLD };
