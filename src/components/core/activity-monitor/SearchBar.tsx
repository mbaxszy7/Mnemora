import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence, type Variants } from "framer-motion";
import { Search, Sparkles, Settings, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useContextSearch } from "@/hooks/use-context-search";
import type { SearchResult } from "@shared/context-types";
import { useViewTransition } from "../view-transition";

interface SearchBarProps {
  onSearchStart?: (query: string) => void;
  onSearchComplete?: (result: SearchResult, query: string) => void;
  onSearchCancel?: () => void;
  variants?: Variants;
}

export function SearchBar({
  onSearchStart,
  onSearchComplete,
  onSearchCancel,
  variants,
}: SearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [isFocused, setIsFocused] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [hasPermissionIssue, setHasPermissionIssue] = useState(false);
  const { navigate } = useViewTransition();
  const { search, cancel } = useContextSearch();
  const grantedRef = useRef(false);

  // Check permission status
  const checkPermission = useCallback(async () => {
    if (grantedRef.current) return;
    try {
      const result = await window.permissionApi.check();
      if (result.success && result.data) {
        const allGranted =
          result.data.screenRecording === "granted" && result.data.accessibility === "granted";
        setHasPermissionIssue(!allGranted);
        if (allGranted) {
          grantedRef.current = true;
        }
      }
    } catch {
      // Ignore errors
    }
  }, []);

  useEffect(() => {
    void checkPermission();

    const unsubscribePermissionChanged =
      typeof window.permissionApi.onStatusChanged === "function"
        ? window.permissionApi.onStatusChanged((payload) => {
            const allGranted =
              payload.screenRecording === "granted" && payload.accessibility === "granted";
            setHasPermissionIssue(!allGranted);
            grantedRef.current = allGranted;
          })
        : null;

    const handleFocus = () => {
      void checkPermission();
    };

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void checkPermission();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribePermissionChanged?.();
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkPermission]);

  const handleSearch = useCallback(async () => {
    if (!query.trim() || isSearching) return;

    setIsSearching(true);
    onSearchStart?.(query.trim());

    try {
      const result = await search({
        query: query.trim(),
        deepSearch: true,
        topK: 20,
      });

      if (result.success && result.data) {
        onSearchComplete?.(result.data, query.trim());
      }
    } catch {
      // Search was cancelled or failed
    } finally {
      setIsSearching(false);
    }
  }, [query, isSearching, search, onSearchStart, onSearchComplete]);

  const handleCancel = useCallback(async () => {
    await cancel();
    setIsSearching(false);
    onSearchCancel?.();
  }, [cancel, onSearchCancel]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSearch();
  };

  const showSearchButton = query.trim().length > 0;

  return (
    <motion.div layout className="flex items-center gap-4 px-2 py-3 w-full" variants={variants}>
      {/* Search Input */}
      <form onSubmit={handleSubmit} className="flex-1 relative">
        <motion.div
          animate={{
            boxShadow: isFocused ? "0 0 0 2px hsl(var(--ring))" : "0 0 0 0px transparent",
          }}
          transition={{ duration: 0.2 }}
          className="relative rounded-lg flex"
        >
          <div className="absolute left-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 pointer-events-none">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Sparkles className="h-3.5 w-3.5 text-primary/70" />
          </div>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => setIsFocused(true)}
            onBlur={() => setIsFocused(false)}
            disabled={isSearching}
            placeholder={t("activityMonitor.search.placeholder")}
            className="pl-14 pr-12 h-10 bg-secondary/30 border-0 focus-visible:ring-1 focus-visible:ring-primary/20 focus-visible:ring-offset-0 disabled:opacity-70 disabled:cursor-not-allowed placeholder:italic"
          />
          {/* Search/Cancel Button */}
          <AnimatePresence mode="wait">
            {(showSearchButton || isSearching) && (
              <motion.div
                className="absolute right-1 top-1/2 -translate-y-1/2"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
                transition={{ duration: 0.15 }}
              >
                {isSearching ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={handleCancel}
                  >
                    <motion.div
                      initial={{ rotate: 0 }}
                      animate={{ rotate: 180 }}
                      transition={{ duration: 0.2 }}
                    >
                      <X className="h-4 w-4" />
                    </motion.div>
                  </Button>
                ) : (
                  <Button
                    type="submit"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-primary hover:text-primary hover:bg-primary/10"
                  >
                    <Search className="h-4 w-4" />
                  </Button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          {/* Loading indicator overlay */}
          {isSearching && (
            <motion.div
              className="absolute right-10 top-1/2 -translate-y-1/2"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </motion.div>
          )}
        </motion.div>
      </form>

      {/* Settings Button */}
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.div
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              className="relative"
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate("/settings")}
                className="h-10 w-10"
                disabled={isSearching}
              >
                <Settings className="h-5 w-5" />
              </Button>
              {/* Permission warning red dot */}
              {hasPermissionIssue && (
                <motion.span
                  className="absolute top-1 right-1 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-background"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              )}
            </motion.div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>
              {hasPermissionIssue
                ? t("activityMonitor.settings.permissionWarning")
                : t("nav.settings")}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </motion.div>
  );
}
