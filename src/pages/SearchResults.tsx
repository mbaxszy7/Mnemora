import { Suspense, lazy } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { ArrowLeft, Search, Sparkles, FileText, Clock } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useViewTransition } from "@/components/core/view-transition";
import type { SearchResult, ExpandedContextNode } from "@shared/context-types";

const MarkdownContent = lazy(() =>
  import("@/components/core/activity-monitor/MarkdownContent").then((m) => ({
    default: m.MarkdownContent,
  }))
);

function MarkdownSkeleton() {
  return (
    <div className="space-y-2">
      <Skeleton className="h-5 w-7/12" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
      <Skeleton className="h-28 w-full rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-9/12" />
      </div>
    </div>
  );
}

interface SearchResultsLocationState {
  query: string;
  deepSearch: boolean;
  result: SearchResult;
}

function NodeCard({ node }: { node: ExpandedContextNode }) {
  const { t } = useTranslation();

  const kindColors: Record<string, string> = {
    event: "bg-blue-500/10 text-blue-500",
    knowledge: "bg-purple-500/10 text-purple-500",
    state_snapshot: "bg-green-500/10 text-green-500",
    procedure: "bg-orange-500/10 text-orange-500",
    plan: "bg-amber-500/10 text-amber-500",
    entity_profile: "bg-pink-500/10 text-pink-500",
  };

  return (
    <motion.div
      className="rounded-lg border border-border/50 bg-card/50 overflow-hidden"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ scale: 1.01 }}
      transition={{ duration: 0.2 }}
    >
      <div className="px-4 py-3">
        <div className="flex items-start gap-3">
          {/* Kind badge */}
          <Badge variant="secondary" className={kindColors[node.kind] || "bg-secondary"}>
            {t(`searchResults.kinds.${node.kind}`, node.kind)}
          </Badge>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <h4 className="text-sm font-medium mb-1">{node.title}</h4>
            <p className="text-xs text-muted-foreground line-clamp-2">{node.summary}</p>

            {/* Meta info */}
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              {node.eventTime && (
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {format(new Date(node.eventTime), "MM/dd HH:mm")}
                </span>
              )}
              {node.keywords.length > 0 && (
                <div className="flex items-center gap-1">
                  {node.keywords.slice(0, 3).map((keyword) => (
                    <Badge key={keyword} variant="outline" className="text-[10px] px-1.5 py-0">
                      {keyword}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Importance indicator */}
          {node.importance >= 7 && (
            <div className="flex items-center gap-1">
              <Sparkles className="h-4 w-4 text-amber-500" />
            </div>
          )}
        </div>
      </div>

      {/* Importance bar */}
      {node.importance >= 7 && (
        <motion.div
          className="h-0.5 bg-linear-to-r from-amber-500 to-orange-500"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ delay: 0.2, duration: 0.3 }}
        />
      )}
    </motion.div>
  );
}

export default function SearchResultsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { navigate } = useViewTransition();
  const state = location.state as SearchResultsLocationState | null;

  // If no state, redirect back
  if (!state) {
    return (
      <motion.div
        className="h-[calc(100vh-88px)] flex flex-col items-center justify-center text-center p-8"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <Search className="h-16 w-16 text-muted-foreground/30 mb-4" />
        <h3 className="text-lg font-medium text-muted-foreground mb-2">
          {t("searchResults.noResults")}
        </h3>
        <p className="text-sm text-muted-foreground/70 mb-4">
          {t("searchResults.noResultsDescription")}
        </p>
        <Button onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t("searchResults.backToHome")}
        </Button>
      </motion.div>
    );
  }

  const { query, deepSearch, result } = state;
  const hasAnswer = result.answer && result.answer.answer;
  const hasNodes = result.nodes.length > 0;
  const hasRelatedEvents = result.relatedEvents.length > 0;

  return (
    <motion.div
      className="h-[calc(100vh-88px)] flex flex-col -mt-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.3 }}
    >
      {/* Header */}
      <div className="flex items-center gap-4 px-4 py-3 border-b border-border/50">
        <motion.div whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
          <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </motion.div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium truncate">{query}</span>
            {deepSearch && (
              <Badge variant="secondary" className="text-xs">
                <Sparkles className="h-3 w-3 mr-1" />
                {t("activityMonitor.search.deepSearch")}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t("searchResults.resultCount", { count: result.nodes.length })}
          </p>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-4 space-y-6">
          {/* Synthesized Answer (Deep Search only) */}
          {hasAnswer && (
            <motion.div
              className="rounded-xl border border-primary/20 bg-primary/5 p-5"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="h-5 w-5 text-primary" />
                <h3 className="font-semibold">
                  {result.answer!.answerTitle || t("searchResults.answer")}
                </h3>
              </div>
              <Suspense fallback={<MarkdownSkeleton />}>
                <MarkdownContent content={result.answer!.answer} />
              </Suspense>

              {/* Bullets */}
              {result.answer!.bullets && result.answer!.bullets.length > 0 && (
                <div className="mt-4 space-y-1.5">
                  {result.answer!.bullets.map((bullet, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                      <span className="text-primary">•</span>
                      <span>{bullet}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Follow-ups */}
              {result.answer!.followUps && result.answer!.followUps.length > 0 && (
                <div className="mt-4 pt-4 border-t border-border/30">
                  <p className="text-xs text-muted-foreground mb-2">
                    {t("searchResults.followUpQuestions")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {result.answer!.followUps.map((followUp, i) => (
                      <Badge
                        key={i}
                        variant="outline"
                        className="text-xs cursor-pointer hover:bg-secondary"
                      >
                        {followUp}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* Matched Nodes */}
          {hasNodes && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
                <FileText className="h-4 w-4 text-blue-500" />
                {t("searchResults.matchedNodes")}
              </h3>
              <div className="space-y-3">
                {result.nodes.map((node, i) => (
                  <motion.div
                    key={node.id || i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 + i * 0.05 }}
                  >
                    <NodeCard node={node} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* Related Events */}
          {hasRelatedEvents && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25 }}
            >
              <h3 className="text-base font-semibold mb-3 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-amber-500" />
                {t("searchResults.relatedEvents")}
              </h3>
              <div className="space-y-3">
                {result.relatedEvents.map((node, i) => (
                  <motion.div
                    key={node.id || i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3 + i * 0.05 }}
                  >
                    <NodeCard node={node} />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* No results */}
          {!hasNodes && !hasRelatedEvents && !hasAnswer && (
            <motion.div
              className="flex flex-col items-center justify-center text-center py-16"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <Search className="h-12 w-12 text-muted-foreground/30 mb-4" />
              <h3 className="text-lg font-medium text-muted-foreground mb-2">
                {t("searchResults.noResults")}
              </h3>
              <p className="text-sm text-muted-foreground/70">
                {t("searchResults.tryDifferentQuery")}
              </p>
            </motion.div>
          )}
        </div>
      </ScrollArea>
    </motion.div>
  );
}
