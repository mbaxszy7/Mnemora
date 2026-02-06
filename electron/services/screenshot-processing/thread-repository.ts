import crypto from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb } from "../../database";
import { batches, contextNodes, threads, type NewThreadRecord } from "../../database/schema";
import { getLogger } from "../logger";

import { processingConfig } from "./config";
import type { ThreadLLMOutput } from "./schemas";
import type { AppContextPayload, KnowledgePayload, StateSnapshotPayload } from "./types";

const logger = getLogger("thread-repository");

// Batch node from DB (input data for thread LLM assignment)
type BatchNodeRow = {
  id: number;
  eventTime: number;
  title: string;
  summary: string;
  threadId: string | null;
  threadSnapshot: string | null;
  appContext: string;
  knowledge: string | null;
  stateSnapshot: string | null;
  keywords: string;
};

// Minimal fields for thread aggregate stats (avoids reading full node rows)
type ThreadAggregateNodeRow = Pick<
  BatchNodeRow,
  "eventTime" | "appContext" | "knowledge" | "stateSnapshot" | "keywords"
>;

// Snapshot written to context_nodes.thread_snapshot_json (for UI/monitoring/debugging)
type ThreadSnapshotPayload = {
  threadId: string;
  title: string;
  summary: string;
  durationMs: number;
  startTime: number;
  lastActiveAt: number;
  currentPhase?: string | null;
  currentFocus?: string | null;
  mainProject?: string | null;
};

// Aggregated stats result for threads table
type ThreadStatAggregate = {
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  apps: string[];
  mainProject: string | null;
  keyEntities: string[];
};

/**
 * Safe JSON.parse wrapper: handles empty or corrupted JSON from DB
 */
function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Generate idempotent key for new thread creation (stored in threads.origin_key).
 * Within the same batch, if nodeIndices remain unchanged during retry, originKey stays the same:
 * - INSERT triggers UNIQUE(origin_key) conflict
 * - Query and reuse existing threadId
 */
function computeThreadOriginKey(args: { batchDbId: number; nodeIndices: number[] }): string {
  const normalized = [...args.nodeIndices].sort((a, b) => a - b).join(",");
  return `batch:${args.batchDbId}|nodes:${normalized}`;
}

/**
 * Generate random threadId (UUID v4).
 * Note: intentionally not using deterministic id; idempotency is ensured by originKey UNIQUE constraint.
 */
function generateThreadId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Calculate thread continuous duration (durationMs):
 * - eventTimesAsc must be sorted in ascending order
 * - Intervals exceeding gapThresholdMs are excluded from duration
 */
function computeDurationMs(eventTimesAsc: number[], gapThresholdMs: number): number {
  let duration = 0;
  for (let i = 1; i < eventTimesAsc.length; i++) {
    const delta = eventTimesAsc[i] - eventTimesAsc[i - 1];
    if (delta > 0 && delta <= gapThresholdMs) {
      duration += delta;
    }
  }
  return duration;
}

/**
 * Extract entity keywords from a single node's JSON fields (for threads.key_entities_json)
 */
function extractEntitiesFromNode(node: ThreadAggregateNodeRow): string[] {
  const keywords = safeJsonParse<string[]>(node.keywords, []);
  const knowledge = safeJsonParse<KnowledgePayload | null>(node.knowledge, null);
  const stateSnapshot = safeJsonParse<StateSnapshotPayload | null>(node.stateSnapshot, null);

  const out = new Set<string>();
  for (const k of keywords) {
    if (typeof k === "string" && k.trim()) out.add(k.trim());
  }
  if (knowledge?.projectOrLibrary) out.add(knowledge.projectOrLibrary);
  if (stateSnapshot?.subject) out.add(stateSnapshot.subject);
  return Array.from(out);
}

/**
 * Extract app hints from a single node's app_context_json (for threads.apps_json)
 */
function extractAppsFromNode(node: ThreadAggregateNodeRow): string[] {
  const app = safeJsonParse<AppContextPayload>(node.appContext, {
    appHint: null,
    windowTitle: null,
    sourceKey: "",
  });

  const hint = app.appHint?.trim();
  return hint ? [hint] : [];
}
function extractProjectKeysFromNode(node: ThreadAggregateNodeRow): string[] {
  const app = safeJsonParse<AppContextPayload>(node.appContext, {
    appHint: null,
    windowTitle: null,
    sourceKey: "",
    projectName: null,
    projectKey: null,
  });

  const key = (app.projectKey ?? app.projectName ?? "").trim();
  return key ? [key] : [];
}

/**
 * Compute thread aggregate stats:
 * - eventTimesAsc: all event_times for durationMs/nodeCount/start/last (strong consistency)
 * - recentNodes: only recent N nodes for apps/entities (acceptable weak consistency to avoid performance issues)
 */
function computeThreadAggregatesFromEventTimesAndRecentNodes(args: {
  eventTimesAsc: number[];
  recentNodes: ThreadAggregateNodeRow[];
}): ThreadStatAggregate {
  const times = args.eventTimesAsc;
  if (times.length === 0) {
    return {
      startTime: 0,
      lastActiveAt: 0,
      durationMs: 0,
      nodeCount: 0,
      apps: [],
      mainProject: null,
      keyEntities: [],
    };
  }

  const startTime = times[0];
  const lastActiveAt = times[times.length - 1];
  const durationMs = computeDurationMs(times, processingConfig.thread.gapThresholdMs);

  const apps = new Set<string>();
  const entities = new Map<string, number>();
  const projects = new Map<string, number>();

  for (const node of args.recentNodes) {
    for (const a of extractAppsFromNode(node)) {
      apps.add(a);
    }
    for (const p of extractProjectKeysFromNode(node)) {
      projects.set(p, (projects.get(p) ?? 0) + 1);
    }
    for (const e of extractEntitiesFromNode(node)) {
      entities.set(e, (entities.get(e) ?? 0) + 1);
    }
  }

  const mainProject = (() => {
    const sorted = Array.from(projects.entries()).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    return sorted.length > 0 ? sorted[0][0] : null;
  })();

  const keyEntities = Array.from(entities.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 20)
    .map(([name]) => name);

  return {
    startTime,
    lastActiveAt,
    durationMs,
    nodeCount: times.length,
    apps: Array.from(apps).slice(0, 20),
    mainProject,
    keyEntities,
  };
}

/**
 * Strong validation for thread LLM output:
 * - assignments must cover every nodeIndex in batch without duplicates
 * - NEW mapping must be uniquely resolvable in new_threads.node_indices
 * - nodeIndices in new_threads must be marked as NEW in assignments (bidirectional consistency)
 */
function validateThreadLlmOutput(output: ThreadLLMOutput, batchNodeCount: number): void {
  if (batchNodeCount <= 0) {
    throw new Error("No batch nodes to assign");
  }

  if (output.assignments.length !== batchNodeCount) {
    throw new Error(
      `Invalid thread LLM output: assignments length ${output.assignments.length} != ${batchNodeCount}`
    );
  }

  const seen = new Set<number>();
  for (const a of output.assignments) {
    if (!Number.isInteger(a.nodeIndex) || a.nodeIndex < 0 || a.nodeIndex >= batchNodeCount) {
      throw new Error(`Invalid assignment nodeIndex: ${a.nodeIndex}`);
    }
    if (seen.has(a.nodeIndex)) {
      throw new Error(`Duplicate assignment for nodeIndex ${a.nodeIndex}`);
    }
    seen.add(a.nodeIndex);
  }

  for (let i = 0; i < batchNodeCount; i++) {
    if (!seen.has(i)) {
      throw new Error(`Missing assignment for nodeIndex ${i}`);
    }
  }

  const newNodeIndexToThread = new Map<number, number>();
  output.newThreads.forEach((t, idx) => {
    for (const ni of t.nodeIndices) {
      if (!Number.isInteger(ni) || ni < 0 || ni >= batchNodeCount) {
        throw new Error(`Invalid new_thread nodeIndex: ${ni}`);
      }
      if (newNodeIndexToThread.has(ni)) {
        throw new Error(`nodeIndex ${ni} appears in multiple new_threads`);
      }
      newNodeIndexToThread.set(ni, idx);
    }
  });

  const assignmentNewCount = output.assignments.filter((a) => a.threadId === "NEW").length;
  if (assignmentNewCount > 0 && output.newThreads.length === 0) {
    throw new Error("assignments contains NEW but new_threads is empty");
  }

  for (const a of output.assignments) {
    if (a.threadId === "NEW") {
      if (!newNodeIndexToThread.has(a.nodeIndex)) {
        throw new Error(`Assignment NEW nodeIndex ${a.nodeIndex} not present in any new_threads`);
      }
    }
  }

  const threadIdByNodeIndex = new Map<number, string>();
  for (const a of output.assignments) {
    threadIdByNodeIndex.set(a.nodeIndex, a.threadId);
  }
  for (const ni of newNodeIndexToThread.keys()) {
    const threadId = threadIdByNodeIndex.get(ni);
    if (threadId !== "NEW") {
      throw new Error(
        `new_threads contains nodeIndex ${ni} but assignments does not mark it as NEW`
      );
    }
  }
}

export class ThreadRepository {
  /**
   * Convergence path for crash recovery/retry:
   * - Skip LLM call if all nodes in batch already have thread_id
   * - Only recompute thread stats + write thread_snapshot_json for batch + mark batch succeeded
   */
  finalizeBatchWithExistingAssignments(options: {
    batchDbId: number;
    batchNodesAsc: BatchNodeRow[];
  }): { affectedThreadIds: string[]; batchNodeIds: number[] } {
    const db = getDb();
    const now = Date.now();

    const batchNodes = options.batchNodesAsc;
    const batchNodeIds = batchNodes.map((n) => n.id);
    const threadIds = Array.from(
      new Set(batchNodes.map((n) => n.threadId).filter(Boolean))
    ) as string[];

    if (threadIds.length === 0) {
      throw new Error("Cannot finalize batch: no assigned threads on batch nodes");
    }

    return db.transaction((tx) => {
      // Key constraint: insert-only (idempotent)
      this.recomputeThreadsAndWriteSnapshots(tx, { threadIds, batchNodeIds, now });
      this.markBatchSucceeded(tx, { batchDbId: options.batchDbId, now });

      return { affectedThreadIds: threadIds, batchNodeIds };
    });
  }

  /**
   * Apply Thread LLM output to database (within transaction, rollback on failure).
   *
   * Idempotency/retry semantics:
   * - Deduplication/reuse of new threads via threads.origin_key UNIQUE constraint (not deterministic threadId).
   * - context_nodes.thread_id written only when NULL (insert-only) to avoid retry overwrites.
   * - context_nodes.thread_snapshot_json written only when NULL (insert-only) to avoid retry overwrites.
   *
   * Key parameters:
   * - batchNodesAsc: nodes in this batch (order is nodeIndex)
   * - output: LLM response with assignments / thread_updates / new_threads
   */
  applyThreadLlmResult(options: {
    batchDbId: number;
    batchNodesAsc: BatchNodeRow[];
    output: ThreadLLMOutput;
  }): { affectedThreadIds: string[]; assignedNodeIds: number[] } {
    const db = getDb();
    const now = Date.now();

    validateThreadLlmOutput(options.output, options.batchNodesAsc.length);

    return db.transaction((tx) => {
      const output = options.output;
      const batchNodes = options.batchNodesAsc;
      const batchNodeIds = batchNodes.map((n) => n.id);

      // Step 1: Create new_threads (DB idempotent)
      // - threads.id: random UUID
      // - Idempotency via threads.origin_key UNIQUE: query and reuse existing threadId on conflict
      // newThreadIdByIndex: new_threads[i] -> threadId (final id for DB)
      // nodeIndexToNewThreadIndex: nodeIndex -> new_threads[i] (maps assignment.NEW to specific new_thread)
      const newThreadIdByIndex = new Map<number, string>();
      const nodeIndexToNewThreadIndex = new Map<number, number>();
      for (let i = 0; i < output.newThreads.length; i++) {
        for (const ni of output.newThreads[i].nodeIndices) {
          nodeIndexToNewThreadIndex.set(ni, i);
        }
      }

      for (let i = 0; i < output.newThreads.length; i++) {
        const originKey = computeThreadOriginKey({
          batchDbId: options.batchDbId,
          nodeIndices: output.newThreads[i].nodeIndices,
        });

        let newThreadId = generateThreadId();
        newThreadIdByIndex.set(i, newThreadId);

        const nodeTimes = output.newThreads[i].nodeIndices
          .map((idx) => batchNodes[idx]?.eventTime)
          .filter((t): t is number => typeof t === "number")
          .sort((a, b) => a - b);

        const startTime = nodeTimes.length > 0 ? nodeTimes[0] : now;
        const lastActiveAt = nodeTimes.length > 0 ? nodeTimes[nodeTimes.length - 1] : now;

        const milestonesPayload = output.newThreads[i].milestones.map((m) => ({
          time: now,
          description: m,
        }));

        const projectCounts = new Map<string, number>();
        for (const idx of output.newThreads[i].nodeIndices) {
          const node = batchNodes[idx];
          if (!node) continue;
          const app = safeJsonParse<AppContextPayload>(node.appContext, {
            appHint: null,
            windowTitle: null,
            sourceKey: "",
            projectName: null,
            projectKey: null,
          });
          const key = (app.projectKey ?? app.projectName ?? "").trim();
          if (!key) continue;
          projectCounts.set(key, (projectCounts.get(key) ?? 0) + 1);
        }
        const mainProject = (() => {
          const sorted = Array.from(projectCounts.entries()).sort(
            (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
          );
          return sorted.length > 0 ? sorted[0][0] : null;
        })();

        const record: NewThreadRecord = {
          id: newThreadId,
          originKey,
          title: output.newThreads[i].title,
          summary: output.newThreads[i].summary,
          currentPhase: output.newThreads[i].currentPhase ?? null,
          currentFocus: null,
          status: "active",
          startTime,
          lastActiveAt,
          durationMs: 0,
          nodeCount: 0,
          apps: "[]",
          mainProject,
          keyEntities: "[]",
          milestones: JSON.stringify(milestonesPayload),
          createdAt: now,
          updatedAt: now,
        };

        try {
          tx.insert(threads).values(record).run();
        } catch (error) {
          const existing = tx
            .select({ id: threads.id })
            .from(threads)
            .where(eq(threads.originKey, originKey))
            .get();

          if (!existing) {
            throw error;
          }

          newThreadId = existing.id;
          newThreadIdByIndex.set(i, newThreadId);
        }
      }

      // Step 2: Validate that referenced "existing threadId" in assignments actually exists
      const existingThreadIds = output.assignments
        .filter((a) => a.threadId !== "NEW")
        .map((a) => a.threadId);
      const uniqueExisting = Array.from(new Set(existingThreadIds));

      if (uniqueExisting.length > 0) {
        const existing = tx
          .select({ id: threads.id })
          .from(threads)
          .where(inArray(threads.id, uniqueExisting))
          .all();
        const existingSet = new Set(existing.map((r) => r.id));
        for (const id of uniqueExisting) {
          if (!existingSet.has(id)) {
            throw new Error(`Thread id does not exist: ${id}`);
          }
        }
      }

      // Step 3: Build final nodeIndex -> finalThreadId mapping
      // - assignment.threadId != NEW: use directly
      // - assignment.threadId == NEW: resolve via nodeIndexToNewThreadIndex -> newThreadIndex -> newThreadIdByIndex
      const nodeIndexToThreadId = new Map<number, string>();
      for (const a of output.assignments) {
        if (a.threadId === "NEW") {
          const newThreadIndex = nodeIndexToNewThreadIndex.get(a.nodeIndex) ?? -1;
          if (newThreadIndex < 0) {
            throw new Error(`Cannot map NEW assignment nodeIndex ${a.nodeIndex} to new_threads`);
          }
          const finalId = newThreadIdByIndex.get(newThreadIndex);
          if (!finalId) {
            throw new Error(`Missing generated threadId for newThreadIndex ${newThreadIndex}`);
          }
          nodeIndexToThreadId.set(a.nodeIndex, finalId);
        } else {
          nodeIndexToThreadId.set(a.nodeIndex, a.threadId);
        }
      }

      for (let i = 0; i < batchNodes.length; i++) {
        const node = batchNodes[i];
        const mapped = nodeIndexToThreadId.get(i);
        if (!mapped) {
          throw new Error(`Missing thread mapping for nodeIndex ${i}`);
        }
        if (node.threadId && node.threadId !== mapped) {
          throw new Error(
            `Thread mapping mismatch for node ${node.id} (existing=${node.threadId}, mapped=${mapped})`
          );
        }
      }

      // Step 4: Write to context_nodes.thread_id (insert-only)
      // - Only write to rows where thread_id IS NULL to avoid overwriting existing threadId on retry
      const assignedNodeIds: number[] = [];
      for (let i = 0; i < batchNodes.length; i++) {
        const node = batchNodes[i];
        const threadId = nodeIndexToThreadId.get(i);
        if (!threadId) {
          throw new Error(`Missing thread mapping for nodeIndex ${i}`);
        }

        const res = tx
          .update(contextNodes)
          .set({ threadId, updatedAt: now })
          .where(and(eq(contextNodes.id, node.id), isNull(contextNodes.threadId)))
          .run();

        if (res.changes > 0) {
          assignedNodeIds.push(node.id);
        }
      }

      // Step 5: Apply thread_updates (update title/summary/phase/focus + append milestone)
      for (const u of output.threadUpdates) {
        const exists = tx
          .select({ id: threads.id })
          .from(threads)
          .where(eq(threads.id, u.threadId))
          .get();

        if (!exists) {
          throw new Error(`thread_updates references missing thread: ${u.threadId}`);
        }

        const patch: Partial<NewThreadRecord> = {
          updatedAt: now,
        };
        if (u.title != null) patch.title = u.title;
        if (u.summary != null) patch.summary = u.summary;
        if (u.currentPhase != null) patch.currentPhase = u.currentPhase;
        if (u.currentFocus != null) patch.currentFocus = u.currentFocus;

        tx.update(threads).set(patch).where(eq(threads.id, u.threadId)).run();

        if (u.newMilestone?.description) {
          const existing = tx
            .select({ milestones: threads.milestones })
            .from(threads)
            .where(eq(threads.id, u.threadId))
            .get();
          const arr = safeJsonParse<Array<{ time: number; description: string }>>(
            existing?.milestones ?? null,
            []
          );
          arr.push({ time: now, description: u.newMilestone.description });
          tx.update(threads)
            .set({ milestones: JSON.stringify(arr), updatedAt: now })
            .where(eq(threads.id, u.threadId))
            .run();
        }
      }

      // Step 6: Recompute stats for affected threads + write snapshot for batch nodes
      // - Stats use all event_times for consistent gap rules
      // - apps/entities only use recent N nodes (acceptable weak consistency to avoid full JSON parsing)
      const affectedThreadIds = new Set<string>();
      nodeIndexToThreadId.forEach((id) => affectedThreadIds.add(id));
      for (const u of output.threadUpdates) {
        if (u.threadId !== "NEW") affectedThreadIds.add(u.threadId);
      }
      this.recomputeThreadsAndWriteSnapshots(tx, {
        threadIds: Array.from(affectedThreadIds),
        batchNodeIds,
        now,
      });

      // Step 7: Mark batch.thread_llm_status = succeeded
      this.markBatchSucceeded(tx, { batchDbId: options.batchDbId, now });

      logger.info(
        { batchDbId: options.batchDbId, assignedNodeCount: assignedNodeIds.length },
        "Applied thread assignments"
      );

      return { affectedThreadIds: Array.from(affectedThreadIds), assignedNodeIds };
    });
  }

  /**
   * Recompute thread stats and write thread_snapshot_json for batch nodes.
   *
   * Key constraint (idempotent):
   * - snapshot only written when thread_snapshot_json IS NULL (insert-only)
   *
   * Stats strategy:
   * - duration/nodeCount/start/last: use all event_times for correct gap rules
   * - apps/entities: only aggregate recent N nodes to avoid full JSON parse overhead
   */
  private recomputeThreadsAndWriteSnapshots(
    tx: ReturnType<typeof getDb>,
    args: { threadIds: string[]; batchNodeIds: number[]; now: number }
  ): void {
    // For each thread:
    // 1) Read all event_times (for duration/nodeCount/start/last)
    // 2) Read recent N nodes (for apps/entities)
    // 3) Update threads stats and write thread snapshot to batch nodes (only if thread_snapshot_json is empty)
    for (const threadId of args.threadIds) {
      const timeRows = tx
        .select({ eventTime: contextNodes.eventTime })
        .from(contextNodes)
        .where(eq(contextNodes.threadId, threadId))
        .orderBy(asc(contextNodes.eventTime))
        .all();

      const eventTimesAsc = timeRows
        .map((r) => r.eventTime)
        .filter((n): n is number => typeof n === "number");

      const recentNodes = tx
        .select({
          eventTime: contextNodes.eventTime,
          appContext: contextNodes.appContext,
          knowledge: contextNodes.knowledge,
          stateSnapshot: contextNodes.stateSnapshot,
          keywords: contextNodes.keywords,
        })
        .from(contextNodes)
        .where(eq(contextNodes.threadId, threadId))
        .orderBy(desc(contextNodes.eventTime))
        .limit(50)
        .all();

      const agg = computeThreadAggregatesFromEventTimesAndRecentNodes({
        eventTimesAsc,
        recentNodes,
      });

      tx.update(threads)
        .set({
          startTime: agg.startTime,
          lastActiveAt: agg.lastActiveAt,
          durationMs: agg.durationMs,
          nodeCount: agg.nodeCount,
          apps: JSON.stringify(agg.apps),
          mainProject: agg.mainProject,
          keyEntities: JSON.stringify(agg.keyEntities),
          status: "active",
          updatedAt: args.now,
        })
        .where(eq(threads.id, threadId))
        .run();

      const updatedThread = tx.select().from(threads).where(eq(threads.id, threadId)).get();
      if (!updatedThread) {
        continue;
      }

      const snapshot: ThreadSnapshotPayload = {
        threadId: updatedThread.id,
        title: updatedThread.title,
        summary: updatedThread.summary,
        durationMs: updatedThread.durationMs,
        startTime: updatedThread.startTime,
        lastActiveAt: updatedThread.lastActiveAt,
        currentPhase: updatedThread.currentPhase,
        currentFocus: updatedThread.currentFocus,
        mainProject: updatedThread.mainProject,
      };

      // Only write snapshot to batch nodes and only if thread_snapshot_json is empty (avoid retry overwrites)
      tx.update(contextNodes)
        .set({ threadSnapshot: JSON.stringify(snapshot), updatedAt: args.now })
        .where(
          and(
            inArray(contextNodes.id, args.batchNodeIds),
            eq(contextNodes.threadId, threadId),
            isNull(contextNodes.threadSnapshot)
          )
        )
        .run();
    }
  }

  /**
   * Mark batches.thread_llm_status as succeeded and clear error/nextRun fields.
   */
  private markBatchSucceeded(
    tx: ReturnType<typeof getDb>,
    args: { batchDbId: number; now: number }
  ): void {
    // After successful thread assignment, clear error/nextRun and set status to succeeded
    tx.update(batches)
      .set({
        threadLlmStatus: "succeeded",
        threadLlmErrorMessage: null,
        threadLlmNextRunAt: null,
        updatedAt: args.now,
      })
      .where(eq(batches.id, args.batchDbId))
      .run();
  }

  /**
   * Maintain thread lifecycle: mark threads as inactive if last active exceeds inactiveThresholdMs.
   */
  markInactiveThreads(): number {
    const db = getDb();
    const now = Date.now();
    const cutoff = now - processingConfig.thread.inactiveThresholdMs;
    // Lightweight maintenance: mark threads inactive if not active within inactiveThresholdMs
    const result = db
      .update(threads)
      .set({ status: "inactive", updatedAt: now })
      .where(and(eq(threads.status, "active"), lt(threads.lastActiveAt, cutoff)))
      .run();

    return result.changes;
  }
}

export const threadRepository = new ThreadRepository();

export const __test__ = {
  computeDurationMs,
};
