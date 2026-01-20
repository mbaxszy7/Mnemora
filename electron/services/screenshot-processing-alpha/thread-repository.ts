import crypto from "node:crypto";

import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";

import { getDb } from "../../database";
import { batches, contextNodes, threads, type NewThreadRecord } from "../../database/schema";
import { getLogger } from "../logger";

import { processingConfig } from "./config";
import type { ThreadLLMOutput } from "./schemas";
import type { AppContextPayload, KnowledgePayload, StateSnapshotPayload } from "./types";

const logger = getLogger("thread-repository");

// 从 DB 读取的 batch node（thread LLM 分配的输入基础数据）
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

// 用于 thread 聚合统计的最小字段集合（避免把整行 node 读出来）
type ThreadAggregateNodeRow = Pick<
  BatchNodeRow,
  "eventTime" | "appContext" | "knowledge" | "stateSnapshot" | "keywords"
>;

// 写入到 context_nodes.thread_snapshot_json 的快照结构（用于后续 UI/监控/回溯）
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

// threads 表的统计字段聚合结果
type ThreadStatAggregate = {
  startTime: number;
  lastActiveAt: number;
  durationMs: number;
  nodeCount: number;
  apps: string[];
  keyEntities: string[];
};

/**
 * 容错 JSON.parse：DB 中的 JSON 字段可能为空/脏数据
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
 * 生成“创建新 thread”的幂等键（写入 threads.origin_key）。
 * 同一个 batch 内，如果 retry 过程中 new_threads 的 nodeIndices 不变，则 originKey 不变：
 * - INSERT 会触发 UNIQUE(origin_key) 冲突
 * - 进而查询并复用已有 threadId
 */
function computeThreadOriginKey(args: { batchDbId: number; nodeIndices: number[] }): string {
  const normalized = [...args.nodeIndices].sort((a, b) => a - b).join(",");
  return `batch:${args.batchDbId}|nodes:${normalized}`;
}

/**
 * 生成随机 threadId（UUID v4）。
 * 注意：这里故意不做 deterministic id，幂等由 originKey 的唯一约束保证。
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
 * 计算 thread 的连续时长（durationMs）：
 * - eventTimesAsc 必须按时间升序
 * - gapThresholdMs 以上的时间间隔不计入连续时长
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
 * 从单个 node 的 JSON 字段中提取实体词（用于 threads.key_entities_json）
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
 * 从单个 node 的 app_context_json 中提取应用提示（用于 threads.apps_json）
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

/**
 * 计算 threads 聚合统计：
 * - eventTimesAsc：全量 event_time，用于 durationMs/nodeCount/start/last（强一致）
 * - recentNodes：只取最近 N 条节点用于 apps/entities（首版允许弱化，避免性能问题）
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
      keyEntities: [],
    };
  }

  const startTime = times[0];
  const lastActiveAt = times[times.length - 1];
  const durationMs = computeDurationMs(times, processingConfig.thread.gapThresholdMs);

  const apps = new Set<string>();
  const entities = new Map<string, number>();

  for (const node of args.recentNodes) {
    for (const a of extractAppsFromNode(node)) {
      apps.add(a);
    }
    for (const e of extractEntitiesFromNode(node)) {
      entities.set(e, (entities.get(e) ?? 0) + 1);
    }
  }

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
    keyEntities,
  };
}

/**
 * 对 thread LLM 输出做强校验：
 * - assignments 必须覆盖 batch 的每一个 nodeIndex，且无重复
 * - NEW 映射必须能在 new_threads.node_indices 中唯一定位
 * - new_threads 中出现的 nodeIndex 必须在 assignments 中标记为 NEW（双向一致）
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
   * 崩溃恢复/重试用的收敛路径：
   * - 如果这个 batch 的所有 nodes 已经有 thread_id，则不再调用 LLM
   * - 只做：重算 threads 统计 + 补写本 batch 的 thread_snapshot_json + 标记 batch succeeded
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
      // 关键约束：只补不改（幂等）
      this.recomputeThreadsAndWriteSnapshots(tx, { threadIds, batchNodeIds, now });
      this.markBatchSucceeded(tx, { batchDbId: options.batchDbId, now });

      return { affectedThreadIds: threadIds, batchNodeIds };
    });
  }

  /**
   * 应用 Thread LLM 的输出到数据库（事务内完成，失败则整体回滚）。
   *
   * 幂等/重试语义：
   * - 新 thread 的“去重/复用”通过 threads.origin_key 的 UNIQUE 约束保证（而非 deterministic threadId）。
   * - context_nodes.thread_id 只在 NULL 时写入（只补不改），避免重试覆盖。
   * - context_nodes.thread_snapshot_json 只在 NULL 时写入（只补不改），避免重试覆盖。
   *
   * 关键入参：
   * - batchNodesAsc：本 batch 的 nodes（顺序即 nodeIndex）
   * - output：LLM 返回的 assignments / thread_updates / new_threads
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

      // 步骤 1：创建 new_threads（DB 幂等）
      // - threads.id：随机 UUID
      // - 幂等依赖 threads.origin_key 的 UNIQUE 约束：冲突时查询并复用已有 threadId
      // newThreadIdByIndex：new_threads[i] -> threadId（最终落库用的 id）
      // nodeIndexToNewThreadIndex：nodeIndex -> new_threads[i]（用于把 assignment.NEW 映射到具体 new_thread）
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
          mainProject: null,
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

      // 步骤 2：校验 assignments 里引用的“已有 threadId”必须真实存在
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

      // 步骤 3：构建 nodeIndex -> finalThreadId 的最终映射
      // - assignment.threadId != NEW：直接使用
      // - assignment.threadId == NEW：通过 nodeIndexToNewThreadIndex 找到 newThreadIndex，再取 newThreadIdByIndex
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

      // 步骤 4：写入 context_nodes.thread_id（只补不改）
      // - 只对 thread_id IS NULL 的行写入，避免重试时覆盖已有 threadId
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

      // 步骤 5：应用 thread_updates（更新 title/summary/phase/focus + milestone 追加）
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

      // 步骤 6：对受影响的 threads 做统计重算 + 补写本 batch 的 snapshot
      // - 统计使用全量 event_time，保证 gap 规则一致
      // - apps/entities 只取最近 N 条节点（首版允许弱化，避免全量 JSON 解析）
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

      // 步骤 7：标记 batch.thread_llm_status = succeeded
      this.markBatchSucceeded(tx, { batchDbId: options.batchDbId, now });

      logger.info(
        { batchDbId: options.batchDbId, assignedNodeCount: assignedNodeIds.length },
        "Applied thread assignments"
      );

      return { affectedThreadIds: Array.from(affectedThreadIds), assignedNodeIds };
    });
  }

  /**
   * 重算 threads 统计字段，并为“本 batch 的 nodes”补写 thread_snapshot_json。
   *
   * 重要约束（幂等）：
   * - snapshot 仅在 thread_snapshot_json IS NULL 时写入（只补不改）
   *
   * 统计策略：
   * - duration/nodeCount/start/last：使用该 thread 的全量 event_time（保证 gap 规则正确）
   * - apps/entities：只取最近 N 条节点做弱化聚合（避免全量 JSON parse 的性能成本）
   */
  private recomputeThreadsAndWriteSnapshots(
    tx: ReturnType<typeof getDb>,
    args: { threadIds: string[]; batchNodeIds: number[]; now: number }
  ): void {
    // 对每个 thread：
    // 1) 全量读取 event_time（用于 duration/nodeCount/start/last）
    // 2) 读取最近 N 条节点（用于 apps/entities）
    // 3) 更新 threads 表统计字段，并把 thread 快照写入“本 batch 的 nodes”（仅 thread_snapshot_json 为空时写入）
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

      // 只对本 batch 的 nodes 补写 snapshot，且仅在 thread_snapshot_json 为空时写入（避免重试覆盖）
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
   * 将 batches.thread_llm_status 标记为 succeeded，并清理 error/nextRun 字段。
   */
  private markBatchSucceeded(
    tx: ReturnType<typeof getDb>,
    args: { batchDbId: number; now: number }
  ): void {
    // 线程分配成功后，清理 error/nextRun，并把状态置为 succeeded
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
   * 维护 threads 生命周期：超过 inactiveThresholdMs 未活跃的 thread 从 active -> inactive。
   */
  markInactiveThreads(): number {
    const db = getDb();
    const now = Date.now();
    const cutoff = now - processingConfig.thread.inactiveThresholdMs;
    // 轻量维护：超过 inactiveThresholdMs 未活跃的 thread 标记为 inactive
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
