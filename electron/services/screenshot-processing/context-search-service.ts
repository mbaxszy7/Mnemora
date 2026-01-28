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
    const nowTs = Date.now();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const queryPlan = await deepSearchService.understandQuery(
      queryText,
      nowTs,
      timezone,
      abortSignal
    );
    const embeddingText = queryPlan?.embeddingText ?? queryText;
    const filters = queryPlan ? deepSearchService.mergeFilters(undefined, queryPlan) : undefined;

    const { nodes: initialNodes, nodeScoreMap } = await this.collectInitialCandidates(
      queryText,
      embeddingText,
      filters,
      topK,
      abortSignal
    );

    if (initialNodes.length === 0) {
      return { nodes: [], relatedEvents: [], evidence: [], queryPlan: queryPlan ?? undefined };
    }

    let rankedNodes = this.rankNodes(initialNodes, nodeScoreMap, filters);

    const neighborNodes = await this.expandNeighbors(rankedNodes.slice(0, 5), filters);
    if (neighborNodes.length > 0) {
      const mergedMap = new Map<number, ExpandedContextNode>();
      this.mergeNodesById(mergedMap, rankedNodes);
      this.mergeNodesById(mergedMap, neighborNodes);
      rankedNodes = this.rankNodes(Array.from(mergedMap.values()), nodeScoreMap, filters);
    }

    const { nodes: nodesAll, evidence } = await this.attachEvidence(rankedNodes);

    const relatedEvents = nodesAll.filter((n) => n.kind === "event");
    const nodesForUi = this.selectNodesForUi(nodesAll, queryPlan?.kindHint);

    const nodesForAnswer = this.prioritizeNodesForAnswer(
      nodesAll,
      filters,
      queryPlan?.kindHint,
      50
    );
    const answer =
      (await deepSearchService.synthesizeAnswer(
        queryText,
        nodesForAnswer,
        evidence,
        nowTs,
        timezone,
        abortSignal
      )) ?? undefined;

    return {
      nodes: nodesForUi,
      relatedEvents,
      evidence,
      queryPlan: queryPlan ?? undefined,
      answer,
    };
  }

  private async collectInitialCandidates(
    queryText: string,
    embeddingText: string,
    filters: SearchFilters | undefined,
    topK: number,
    abortSignal?: AbortSignal
  ): Promise<{ nodes: ExpandedContextNode[]; nodeScoreMap: Map<number, number> }> {
    const combinedNodeMap = new Map<number, ExpandedContextNode>();
    const nodeScoreMap = new Map<number, number>();

    if (filters?.timeRange) {
      const timeRangeNodes = await this.timeRangeRecall(filters);
      this.mergeNodesById(combinedNodeMap, timeRangeNodes);
    }

    const keywordNodes = await this.keywordSearch(queryText, filters);
    this.mergeNodesById(combinedNodeMap, keywordNodes);
    for (const node of keywordNodes) {
      if (node.id != null) {
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

    return { nodes: Array.from(combinedNodeMap.values()), nodeScoreMap };
  }

  private mergeNodesById(
    map: Map<number, ExpandedContextNode>,
    nodes: ExpandedContextNode[]
  ): void {
    for (const node of nodes) {
      if (node.id == null) continue;
      if (!map.has(node.id)) {
        map.set(node.id, node);
      }
    }
  }

  private rankNodes(
    nodes: ExpandedContextNode[],
    nodeScoreMap: Map<number, number>,
    filters: SearchFilters | undefined
  ): ExpandedContextNode[] {
    return [...nodes].sort((a, b) => {
      const issueBoostA = this.getIssueBoost(a);
      const issueBoostB = this.getIssueBoost(b);

      if (issueBoostA !== issueBoostB) {
        return issueBoostB - issueBoostA;
      }

      const entityBoostA = this.getEntityBoost(a, filters);
      const entityBoostB = this.getEntityBoost(b, filters);

      if (entityBoostA !== entityBoostB) {
        return entityBoostB - entityBoostA;
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
  }

  private async attachEvidence(
    nodesAll: ExpandedContextNode[]
  ): Promise<{ nodes: ExpandedContextNode[]; evidence: ScreenshotEvidence[] }> {
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
    return { nodes: nodesAll, evidence };
  }

  private selectNodesForUi(
    nodesAll: ExpandedContextNode[],
    kindHint?: string
  ): ExpandedContextNode[] {
    if (!kindHint) return nodesAll;
    const filtered = nodesAll.filter((n) => n.kind === kindHint);
    return filtered.length > 0 ? filtered : nodesAll;
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

    const ftsQuery = this.sanitizeFtsQuery(trimmed);
    let ftsRows: Array<{ screenshotId: number | null; score: number }> = [];
    if (ftsQuery) {
      try {
        ftsRows = db
          .select({
            screenshotId: screenshotsFts.rowid,
            score: sql<number>`bm25(screenshots_fts)`,
          })
          .from(screenshotsFts)
          .where(sql`screenshots_fts MATCH ${ftsQuery}`)
          .orderBy(sql`bm25(screenshots_fts)`)
          .limit(limit)
          .all();
      } catch {
        ftsRows = [];
      }
    }

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

      const threadId = filters?.threadId ?? pivot.threadId;

      if (threadId) {
        const before = db
          .select()
          .from(contextNodes)
          .where(and(eq(contextNodes.threadId, threadId), lte(contextNodes.eventTime, pivotTs)))
          .orderBy(desc(contextNodes.eventTime))
          .limit(threadNeighborBefore)
          .all();

        const after = db
          .select()
          .from(contextNodes)
          .where(and(eq(contextNodes.threadId, threadId), gte(contextNodes.eventTime, pivotTs)))
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

      if (filters.entities && filters.entities.length > 0 && !filters.timeRange) {
        const wanted = filters.entities
          .map((e: string) => e.trim().toLowerCase())
          .filter((e: string) => e.length > 0);
        if (wanted.length > 0) {
          const matched = wanted.some((w: string) => this.nodeEntityMatches(node, w));
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

  private getEntityBoost(node: ExpandedContextNode, filters?: SearchFilters): number {
    if (!filters?.entities || filters.entities.length === 0) return 0;

    const wanted = filters.entities.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0);
    if (wanted.length === 0) return 0;

    return wanted.some((w) => this.nodeEntityMatches(node, w)) ? 1 : 0;
  }

  private prioritizeNodesForAnswer(
    nodesAll: ExpandedContextNode[],
    filters: SearchFilters | undefined,
    kindHint?: string,
    budget = 50
  ): ExpandedContextNode[] {
    if (nodesAll.length === 0) return nodesAll;
    if (budget <= 0) return [];

    const selected: ExpandedContextNode[] = [];
    const selectedIds = new Set<number>();

    const pushUnique = (node: ExpandedContextNode) => {
      if (selected.length >= budget) return;
      if (node.id == null) return;
      if (selectedIds.has(node.id)) return;
      selectedIds.add(node.id);
      selected.push(node);
    };

    const takeOrdered = (candidates: ExpandedContextNode[], limit: number) => {
      if (limit <= 0) return;
      for (const node of candidates) {
        if (selected.length >= budget) return;
        if (limit <= 0) return;
        const beforeLen = selected.length;
        pushUnique(node);
        if (selected.length > beforeLen) {
          limit -= 1;
        }
      }
    };

    const pinnedCap = Math.min(20, budget);
    const hintedCap = Math.min(15, Math.max(0, budget - pinnedCap));
    const threadCap = Math.min(10, Math.max(0, budget - pinnedCap - hintedCap));
    const diversityCap = Math.min(5, Math.max(0, budget - pinnedCap - hintedCap - threadCap));

    const pinned = nodesAll
      .filter((n) => n.kind === "event" && this.getEntityBoost(n, filters) > 0)
      .sort((a, b) => (b.eventTime ?? b.createdAt ?? 0) - (a.eventTime ?? a.createdAt ?? 0));
    takeOrdered(pinned, pinnedCap);

    if (kindHint) {
      const hinted = nodesAll.filter((n) => n.kind === kindHint);
      takeOrdered(hinted, hintedCap);
    }

    if (threadCap > 0) {
      const threadMaxTs = new Map<string, number>();
      for (const node of selected) {
        if (!node.threadId) continue;
        const ts = node.eventTime ?? node.createdAt ?? 0;
        const current = threadMaxTs.get(node.threadId) ?? 0;
        if (ts > current) threadMaxTs.set(node.threadId, ts);
      }

      const threadsByRecency = Array.from(threadMaxTs.entries()).sort((a, b) => b[1] - a[1]);
      let remainingThreadCap = threadCap;
      for (const [threadId] of threadsByRecency) {
        if (selected.length >= budget) break;
        if (remainingThreadCap <= 0) break;
        const perThreadCap = Math.min(3, remainingThreadCap);
        const threadCandidates = nodesAll.filter((n) => n.threadId === threadId);
        const beforeLen = selected.length;
        takeOrdered(threadCandidates, perThreadCap);
        remainingThreadCap -= selected.length - beforeLen;
      }
    }

    if (diversityCap > 0 && filters?.timeRange) {
      const { start, end } = filters.timeRange;
      const span = Math.max(1, end - start);
      const bucketCount = diversityCap;
      const bucketSize = Math.max(1, Math.floor(span / bucketCount));
      const pickedBuckets = new Set<number>();

      for (const node of nodesAll) {
        if (selected.length >= budget) break;
        const ts = node.eventTime ?? node.createdAt;
        if (!ts) continue;
        if (ts < start || ts > end) continue;
        const bucket = Math.min(
          bucketCount - 1,
          Math.max(0, Math.floor((ts - start) / bucketSize))
        );
        if (pickedBuckets.has(bucket)) continue;
        const beforeLen = selected.length;
        pushUnique(node);
        if (selected.length > beforeLen) {
          pickedBuckets.add(bucket);
          if (pickedBuckets.size >= bucketCount) break;
        }
      }
    }

    if (selected.length < budget) {
      const target = Math.min(budget, selected.length + diversityCap);
      const usedAppHints = new Set<string>();
      for (const node of selected) {
        const appHint = node.appContext?.appHint;
        if (appHint) usedAppHints.add(appHint);
      }

      for (const node of nodesAll) {
        if (selected.length >= target) break;
        const appHint = node.appContext?.appHint;
        if (!appHint) continue;
        if (usedAppHints.has(appHint)) continue;
        const beforeLen = selected.length;
        pushUnique(node);
        if (selected.length > beforeLen) {
          usedAppHints.add(appHint);
        }
      }
    }

    if (selected.length < budget) {
      for (const node of nodesAll) {
        if (selected.length >= budget) break;
        pushUnique(node);
      }
    }

    return selected;
  }

  private nodeEntityMatches(node: ExpandedContextNode, wantedLower: string): boolean {
    if (!wantedLower) return false;
    for (const entity of node.entities) {
      const candidate = (entity?.name ?? "").trim().toLowerCase();
      if (!candidate) continue;
      if (candidate === wantedLower) return true;
      if (candidate.includes(wantedLower)) return true;
      const tokens = candidate.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (tokens.includes(wantedLower)) return true;
    }
    return false;
  }

  private sanitizeFtsQuery(input: string): string | null {
    const trimmed = input.trim();
    if (!trimmed) return null;
    const normalized = trimmed
      .replace(/["'`]/g, " ")
      .replace(/[?\uff1f!\uff01:\uff1a;\uff1b(){}\u005B\u005D]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!normalized) return null;

    const tokens = normalized.split(" ").filter((t) => t.length > 0);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) return tokens[0];
    return tokens.map((t) => `"${t}"`).join(" AND ");
  }

  private async timeRangeRecall(filters: SearchFilters): Promise<ExpandedContextNode[]> {
    if (!filters.timeRange) return [];

    const db = getDb();
    const conditions = [
      gte(contextNodes.eventTime, filters.timeRange.start),
      lte(contextNodes.eventTime, filters.timeRange.end),
    ];
    if (filters.threadId) {
      conditions.push(eq(contextNodes.threadId, filters.threadId));
    }

    const records = db
      .select()
      .from(contextNodes)
      .where(and(...conditions))
      .orderBy(desc(contextNodes.eventTime))
      .limit(2000)
      .all();

    return records.map((r) => this.recordToExpandedNode(r));
  }
}

export const contextSearchService = new ContextSearchService();
