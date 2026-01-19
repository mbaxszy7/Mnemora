import { and, asc, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";

import { getDb } from "../../database";
import {
  contextNodes,
  contextScreenshotLinks,
  screenshots,
  screenshotsFts,
  vectorDocuments,
} from "../../database/schema";
import { embeddingService } from "./embedding-service";
import { vectorIndexService } from "./vector-index-service";
import { deepSearchService } from "./deep-search-service";
import type {
  ExpandedContextNode,
  ScreenshotEvidence,
  SearchFilters,
  SearchQuery,
  SearchResult,
} from "./types";

const threadNeighborBefore = 3;
const threadNeighborAfter = 3;
const temporalWindowMs = 2 * 60 * 1000;

export class ContextSearchService {
  async search(query: SearchQuery, abortSignal?: AbortSignal): Promise<SearchResult> {
    const queryText = query.trim();
    if (!queryText) {
      return { nodes: [], relatedEvents: [], evidence: [] };
    }

    const topK = 20;
    let queryPlan = null;
    let embeddingText = queryText;
    let filters: SearchFilters | undefined;

    const nowTs = Date.now();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    queryPlan = await deepSearchService.understandQuery(queryText, nowTs, timezone, abortSignal);
    if (queryPlan) {
      embeddingText = queryPlan.embeddingText;
      filters = deepSearchService.mergeFilters(undefined, queryPlan);
    }

    const combinedNodeMap = new Map<number, ExpandedContextNode>();
    const nodeScoreMap = new Map<number, number>();

    const keywordNodes = await this.keywordSearch(queryText, filters);
    for (const node of keywordNodes) {
      if (node.id != null) {
        combinedNodeMap.set(node.id, node);
        nodeScoreMap.set(node.id, 0);
      }
    }

    const semantic = await this.semanticSearch(embeddingText, topK, filters, abortSignal);
    for (const { node, score } of semantic) {
      if (node.id == null) continue;
      if (!combinedNodeMap.has(node.id)) {
        combinedNodeMap.set(node.id, node);
      }
      const current = nodeScoreMap.get(node.id) ?? Infinity;
      nodeScoreMap.set(node.id, Math.min(current, score));
    }

    const pivotNodes = Array.from(combinedNodeMap.values()).slice(0, 5);
    const neighborNodes = await this.expandNeighbors(pivotNodes, filters);
    for (const node of neighborNodes) {
      if (node.id != null && !combinedNodeMap.has(node.id)) {
        combinedNodeMap.set(node.id, node);
      }
    }

    const nodesAll = Array.from(combinedNodeMap.values());
    if (nodesAll.length === 0) {
      return { nodes: [], relatedEvents: [], evidence: [], queryPlan: queryPlan ?? undefined };
    }

    nodesAll.sort((a, b) => {
      const issueBoostA = this.getIssueBoost(a);
      const issueBoostB = this.getIssueBoost(b);

      if (issueBoostA !== issueBoostB) {
        return issueBoostB - issueBoostA;
      }

      const idA = a.id ?? -1;
      const idB = b.id ?? -1;

      const scoreA = nodeScoreMap.get(idA);
      const scoreB = nodeScoreMap.get(idB);

      const hasScoreA = scoreA !== undefined;
      const hasScoreB = scoreB !== undefined;

      if (hasScoreA && !hasScoreB) return -1;
      if (!hasScoreA && hasScoreB) return 1;

      const tsA = a.eventTime ?? a.createdAt ?? 0;
      const tsB = b.eventTime ?? b.createdAt ?? 0;

      if (!hasScoreA && !hasScoreB) {
        return tsB - tsA;
      }

      const weightA = 1.2 - (a.importance ?? 5) / 10;
      const weightB = 1.2 - (b.importance ?? 5) / 10;
      const diff = (scoreA as number) * weightA - (scoreB as number) * weightB;

      if (diff !== 0) {
        return diff;
      }

      return tsB - tsA;
    });

    const finalNodeIds = nodesAll
      .map((n) => n.id)
      .filter((id): id is number => typeof id === "number");

    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(finalNodeIds);
    for (const node of nodesAll) {
      if (node.id != null) {
        node.screenshotIds = screenshotIdsByNodeId.get(node.id) ?? [];
      }
    }

    const allScreenshotIds: number[] = [];
    for (const ids of screenshotIdsByNodeId.values()) {
      allScreenshotIds.push(...ids);
    }

    const evidence = await this.getEvidenceForScreenshotIds(Array.from(new Set(allScreenshotIds)));

    const relatedEvents = nodesAll.filter((n) => n.kind === "event");
    let otherNodes = nodesAll.filter((n) => n.kind !== "event");

    if (queryPlan?.kindHint) {
      otherNodes = [...otherNodes].sort((a, b) => {
        const aMatches = a.kind === queryPlan.kindHint;
        const bMatches = b.kind === queryPlan.kindHint;
        if (aMatches && !bMatches) return -1;
        if (!aMatches && bMatches) return 1;
        return 0;
      });
    }

    let answer = undefined;
    if (nodesAll.length > 0) {
      answer =
        (await deepSearchService.synthesizeAnswer(
          queryText,
          nodesAll,
          evidence,
          nowTs,
          timezone,
          abortSignal
        )) ?? undefined;
    }

    return {
      nodes: otherNodes,
      relatedEvents,
      evidence,
      queryPlan: queryPlan ?? undefined,
      answer,
    };
  }

  async getThread(threadId: string): Promise<ExpandedContextNode[]> {
    const db = getDb();

    const records = db
      .select()
      .from(contextNodes)
      .where(eq(contextNodes.threadId, threadId))
      .orderBy(asc(contextNodes.eventTime))
      .all();

    const nodes = records.map((r) => this.recordToExpandedNode(r));

    const nodeIds = nodes.map((n) => n.id).filter((id): id is number => id != null);
    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(nodeIds);
    for (const node of nodes) {
      if (node.id != null) {
        node.screenshotIds = screenshotIdsByNodeId.get(node.id) ?? [];
      }
    }

    return nodes;
  }

  async getEvidence(nodeIds: number[]): Promise<ScreenshotEvidence[]> {
    const screenshotIdsByNodeId = this.getScreenshotIdsByNodeIds(nodeIds);
    const allScreenshotIds: number[] = [];
    for (const ids of screenshotIdsByNodeId.values()) {
      allScreenshotIds.push(...ids);
    }
    return this.getEvidenceForScreenshotIds(Array.from(new Set(allScreenshotIds)));
  }

  private async keywordSearch(
    queryText: string,
    filters?: SearchFilters
  ): Promise<ExpandedContextNode[]> {
    const db = getDb();
    const trimmed = queryText.trim();
    if (!trimmed) {
      return [];
    }

    const limit = 30;
    const termCandidates = new Set<string>();
    termCandidates.add(trimmed);

    for (const term of trimmed.split(/\s+/)) {
      if (term.length > 1) {
        termCandidates.add(term);
      }
    }

    if (filters?.entities && filters.entities.length > 0) {
      for (const entity of filters.entities) {
        const normalized = entity.trim();
        if (normalized) {
          termCandidates.add(normalized);
        }
      }
    }

    const terms = Array.from(termCandidates).slice(0, 8);
    const nodesById = new Map<number, ExpandedContextNode>();

    if (terms.length > 0) {
      const termConditions = terms.map((term) =>
        or(
          like(contextNodes.title, `%${term}%`),
          like(contextNodes.summary, `%${term}%`),
          like(contextNodes.keywords, `%${term}%`),
          like(contextNodes.entities, `%${term}%`)
        )
      );

      const directConditions = [or(...termConditions)];
      if (filters?.timeRange) {
        directConditions.push(gte(contextNodes.eventTime, filters.timeRange.start));
        directConditions.push(lte(contextNodes.eventTime, filters.timeRange.end));
      }
      if (filters?.threadId) {
        directConditions.push(eq(contextNodes.threadId, filters.threadId));
      }

      const directRecords = db
        .select()
        .from(contextNodes)
        .where(and(...directConditions))
        .limit(limit)
        .all();

      for (const record of directRecords) {
        nodesById.set(record.id, this.recordToExpandedNode(record));
      }
    }

    const ftsRows = db
      .select({
        screenshotId: screenshotsFts.rowid,
        score: sql<number>`bm25(screenshots_fts)`,
      })
      .from(screenshotsFts)
      .where(sql`screenshots_fts MATCH ${trimmed}`)
      .orderBy(sql`bm25(screenshots_fts)`)
      .limit(limit)
      .all();

    if (ftsRows.length > 0) {
      const screenshotIds = ftsRows
        .map((r) => r.screenshotId)
        .filter((id): id is number => typeof id === "number");

      if (screenshotIds.length > 0) {
        const nodeIds = db
          .select({ nodeId: contextScreenshotLinks.nodeId })
          .from(contextScreenshotLinks)
          .where(inArray(contextScreenshotLinks.screenshotId, screenshotIds))
          .all()
          .map((r) => r.nodeId);

        if (nodeIds.length > 0) {
          const records = db
            .select()
            .from(contextNodes)
            .where(inArray(contextNodes.id, Array.from(new Set(nodeIds))))
            .all();

          for (const record of records) {
            if (!nodesById.has(record.id)) {
              nodesById.set(record.id, this.recordToExpandedNode(record));
            }
          }
        }
      }
    }

    if (nodesById.size === 0) {
      return [];
    }

    return this.applyFilters(Array.from(nodesById.values()), filters);
  }

  private async semanticSearch(
    queryText: string,
    topK: number,
    filters?: SearchFilters,
    abortSignal?: AbortSignal
  ): Promise<Array<{ node: ExpandedContextNode; score: number }>> {
    const db = getDb();

    const embedding = await embeddingService.embed(queryText, abortSignal);
    const matches = await vectorIndexService.search(embedding, topK);

    if (matches.length === 0) {
      return [];
    }

    const matchMap = new Map(matches.map((m) => [m.docId, m] as const));
    const docIds = matches.map((m) => m.docId);

    const docs = db
      .select({ id: vectorDocuments.id, refId: vectorDocuments.refId })
      .from(vectorDocuments)
      .where(inArray(vectorDocuments.id, docIds))
      .all();

    const refIds = docs.map((d) => d.refId);
    if (refIds.length === 0) {
      return [];
    }

    const records = db.select().from(contextNodes).where(inArray(contextNodes.id, refIds)).all();
    const byId = new Map(records.map((r) => [r.id, r] as const));

    const out: Array<{ node: ExpandedContextNode; score: number }> = [];

    for (const doc of docs) {
      const match = matchMap.get(doc.id);
      if (!match) continue;
      const record = byId.get(doc.refId);
      if (!record) continue;
      const node = this.recordToExpandedNode(record);
      const filtered = this.applyFilters([node], filters);
      if (filtered.length === 0) continue;
      out.push({ node: filtered[0], score: match.score });
    }

    return out;
  }

  private async expandNeighbors(
    pivots: ExpandedContextNode[],
    filters?: SearchFilters
  ): Promise<ExpandedContextNode[]> {
    const db = getDb();
    const out = new Map<number, ExpandedContextNode>();

    for (const pivot of pivots) {
      if (pivot.id == null) continue;

      const pivotTs = pivot.eventTime;
      if (!pivotTs) continue;

      const forcedThreadId = filters?.threadId;
      const threadId = forcedThreadId ?? pivot.threadId;

      if (threadId) {
        const before = db
          .select()
          .from(contextNodes)
          .where(
            and(
              eq(contextNodes.threadId, threadId),
              lte(contextNodes.eventTime, pivotTs),
              forcedThreadId ? eq(contextNodes.threadId, forcedThreadId) : sql`1=1`
            )
          )
          .orderBy(desc(contextNodes.eventTime))
          .limit(threadNeighborBefore)
          .all();

        const after = db
          .select()
          .from(contextNodes)
          .where(
            and(
              eq(contextNodes.threadId, threadId),
              gte(contextNodes.eventTime, pivotTs),
              forcedThreadId ? eq(contextNodes.threadId, forcedThreadId) : sql`1=1`
            )
          )
          .orderBy(asc(contextNodes.eventTime))
          .limit(threadNeighborAfter)
          .all();

        for (const record of [...before, ...after]) {
          const node = this.recordToExpandedNode(record);
          const filtered = this.applyFilters([node], filters);
          if (filtered.length === 0 || node.id == null) continue;
          out.set(node.id, node);
        }

        continue;
      }

      const windowStart = pivotTs - temporalWindowMs;
      const windowEnd = pivotTs + temporalWindowMs;

      const records = db
        .select()
        .from(contextNodes)
        .where(
          and(gte(contextNodes.eventTime, windowStart), lte(contextNodes.eventTime, windowEnd))
        )
        .orderBy(asc(contextNodes.eventTime))
        .limit(threadNeighborBefore + threadNeighborAfter)
        .all();

      for (const record of records) {
        const node = this.recordToExpandedNode(record);
        const filtered = this.applyFilters([node], filters);
        if (filtered.length === 0 || node.id == null) continue;
        out.set(node.id, node);
      }
    }

    return Array.from(out.values());
  }

  private applyFilters(
    nodes: ExpandedContextNode[],
    filters?: SearchFilters
  ): ExpandedContextNode[] {
    if (!filters) return nodes;
    let result = nodes.filter((node) => {
      if (filters.threadId && node.threadId !== filters.threadId) {
        return false;
      }

      if (filters.timeRange) {
        const ts = node.eventTime ?? node.createdAt;
        if (!ts) return false;
        if (ts < filters.timeRange.start || ts > filters.timeRange.end) {
          return false;
        }
      }

      if (filters.entities && filters.entities.length > 0) {
        const wanted = filters.entities
          .map((e: string) => e.trim().toLowerCase())
          .filter((e: string) => e.length > 0);
        if (wanted.length > 0) {
          const nodeEntities = node.entities.map((e) => e.name.trim().toLowerCase());
          const matched = wanted.some((w: string) => nodeEntities.includes(w));
          if (!matched) {
            return false;
          }
        }
      }

      return true;
    });

    if (filters.appHint && result.length > 0) {
      const filteredNodeIds = result
        .map((n) => n.id)
        .filter((id): id is number => id !== undefined);
      if (filteredNodeIds.length === 0) {
        return [];
      }

      const db = getDb();
      const nodeIdsWithAppHint = db
        .select({ nodeId: contextScreenshotLinks.nodeId })
        .from(contextScreenshotLinks)
        .innerJoin(screenshots, eq(contextScreenshotLinks.screenshotId, screenshots.id))
        .where(
          and(
            inArray(contextScreenshotLinks.nodeId, filteredNodeIds),
            eq(screenshots.appHint, filters.appHint)
          )
        )
        .all()
        .map((r) => r.nodeId);

      const nodeIdSet = new Set(nodeIdsWithAppHint);
      result = result.filter((n) => n.id && nodeIdSet.has(n.id));
    }

    return result;
  }

  private getScreenshotIdsByNodeIds(nodeIds: number[]): Map<number, number[]> {
    if (nodeIds.length === 0) {
      return new Map();
    }

    const db = getDb();
    const links = db
      .select({
        nodeId: contextScreenshotLinks.nodeId,
        screenshotId: contextScreenshotLinks.screenshotId,
      })
      .from(contextScreenshotLinks)
      .where(inArray(contextScreenshotLinks.nodeId, nodeIds))
      .all();

    const map = new Map<number, Set<number>>();
    for (const link of links) {
      const set = map.get(link.nodeId) ?? new Set<number>();
      set.add(link.screenshotId);
      map.set(link.nodeId, set);
    }

    const out = new Map<number, number[]>();
    for (const [nodeId, set] of map) {
      out.set(nodeId, Array.from(set));
    }
    return out;
  }

  private async getEvidenceForScreenshotIds(
    screenshotIds: number[]
  ): Promise<ScreenshotEvidence[]> {
    if (screenshotIds.length === 0) return [];

    const db = getDb();
    const rows = db
      .select({
        id: screenshots.id,
        ts: screenshots.ts,
        appHint: screenshots.appHint,
        windowTitle: screenshots.windowTitle,
      })
      .from(screenshots)
      .where(inArray(screenshots.id, screenshotIds))
      .all();

    return rows
      .map((s) => ({
        screenshotId: s.id,
        timestamp: s.ts,
        appHint: s.appHint ?? undefined,
        windowTitle: s.windowTitle ?? undefined,
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  private recordToExpandedNode(record: typeof contextNodes.$inferSelect): ExpandedContextNode {
    const keywords = this.safeJsonParse<string[]>(record.keywords, []);
    const entities = this.safeJsonParse<ExpandedContextNode["entities"]>(record.entities, []);
    const appContext = this.safeJsonParse<ExpandedContextNode["appContext"]>(record.appContext, {
      appHint: null,
      windowTitle: null,
      sourceKey: "unknown",
    });
    const knowledge = record.knowledge
      ? this.safeJsonParse<ExpandedContextNode["knowledge"]>(record.knowledge, null)
      : null;
    const stateSnapshot = record.stateSnapshot
      ? this.safeJsonParse<ExpandedContextNode["stateSnapshot"]>(record.stateSnapshot, null)
      : null;
    const uiTextSnippets = this.safeJsonParse<string[]>(record.uiTextSnippets, []);
    const threadSnapshot = record.threadSnapshot
      ? this.safeJsonParse<ExpandedContextNode["threadSnapshot"]>(record.threadSnapshot, null)
      : null;

    const issueDetected = this.detectIssue(record.stateSnapshot);
    const boostedImportance = issueDetected ? Math.max(record.importance, 7) : record.importance;

    const kind = record.stateSnapshot ? "state_snapshot" : record.knowledge ? "knowledge" : "event";

    return {
      id: record.id,
      kind,
      batchId: record.batchId,
      threadId: record.threadId ?? undefined,
      threadSnapshot,
      title: record.title,
      summary: record.summary,
      appContext,
      knowledge,
      stateSnapshot,
      uiTextSnippets,
      keywords,
      entities,
      importance: boostedImportance,
      confidence: record.confidence,
      screenshotIds: [],
      eventTime: record.eventTime,
      createdAt: record.createdAt,
    };
  }

  private safeJsonParse<T>(val: string | null, fallback: T): T {
    if (!val) return fallback;
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }

  private detectIssue(stateSnapshotJson: string | null): boolean {
    if (!stateSnapshotJson) {
      return false;
    }
    try {
      const parsed = JSON.parse(stateSnapshotJson) as { issue?: { detected?: boolean } };
      return Boolean(parsed?.issue?.detected);
    } catch {
      return false;
    }
  }

  private getIssueBoost(node: ExpandedContextNode): number {
    return node.stateSnapshot?.issue?.detected ? 1 : 0;
  }
}

export const contextSearchService = new ContextSearchService();
