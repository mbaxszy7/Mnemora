import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments, contextNodes } from "../../database/schema";
import { getLogger } from "../logger";

const logger = getLogger("vector-document-service");

/**
 * VectorDocumentService：vector 流程的“入队/幂等层”。
 *
 * 职责边界：
 * - 负责把 `context_nodes` 的内容映射成可用于 embedding 的规范化文本，并计算 `textHash`。
 * - 负责 upsert `vector_documents` 记录（幂等键 `vectorId = node:${nodeId}`）。
 * - 当内容发生变化时，把 `vector_documents` 的两段状态机重置为 pending，让调度器去推进。
 * - 不负责生成 embedding，也不负责写入 HNSW 索引（这些由 VectorDocumentScheduler/VectorIndexService 完成）。
 *
 * `vector_documents` 关键字段语义：
 * - embedding 子任务：`embeddingStatus/embeddingAttempts/embeddingNextRunAt/embedding`
 * - index 子任务：`indexStatus/indexAttempts/indexNextRunAt`
 * - `embeddingNextRunAt/indexNextRunAt`：下一次允许重试的时间戳（ms），为 null 表示“尽快执行”。
 * - `failed_permanent`：达到最大重试次数后的终态，不再被调度器扫描。
 */

export interface VectorDocumentDirtyEvent {
  reason: string;
  vectorDocumentId?: number;
  nodeId?: number;
}

type VectorDocumentsDirtyListener = (event: VectorDocumentDirtyEvent) => void;

const vectorDocumentsDirtyListeners = new Set<VectorDocumentsDirtyListener>();

/**
 * 订阅 vector_documents “变脏”事件。
 *
 * 目前的主要消费者是 VectorDocumentScheduler：
 * - upsert 把状态置为 pending 后，会通过该回调触发 scheduler.wake()。
 * - 即使 wake 丢失，scheduler 自己也会周期性 scan，因此这是“加速”而不是“唯一驱动”。
 */
export function onVectorDocumentsDirty(listener: VectorDocumentsDirtyListener): () => void {
  vectorDocumentsDirtyListeners.add(listener);
  return () => {
    vectorDocumentsDirtyListeners.delete(listener);
  };
}

function emitVectorDocumentsDirty(event: VectorDocumentDirtyEvent): void {
  for (const listener of vectorDocumentsDirtyListeners) {
    try {
      listener(event);
    } catch (err) {
      logger.warn({ error: String(err) }, "Vector documents dirty listener failed");
    }
  }
}

export class VectorDocumentService {
  /**
   * 为指定的 context node upsert 对应的 `vector_documents` 记录。
   *
   * 幂等策略：
   * - 通过 `vectorId = node:${nodeId}` 定位记录；通过 `textHash` 判断内容是否变化。
   * - 如果 `textHash` 不变，直接返回，避免重复触发 embedding/index。
   *
   * 入队语义（内容变化时）：
   * - 置 `embeddingStatus = pending`，并清空/重置 `embeddingAttempts/embeddingNextRunAt/embedding`。
   * - 同时置 `indexStatus = pending`，并清空/重置 `indexAttempts/indexNextRunAt`。
   * - 触发 dirty 回调，让调度器尽快扫描并推进。
   */
  async upsertForContextNode(
    nodeId: number
  ): Promise<{ vectorDocumentId: number; vectorId: string }> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    // 1) 构建 embedding 文本与 hash（用于幂等判断）。
    const textContent = await this.buildTextForNode(nodeId); // currently sync-ish but async interface for future
    const textHash = this.computeHash(textContent);
    const vectorId = `node:${nodeId}`;

    // 2) 查找已存在的 vector 文档（按 vectorId）。
    const existing = db
      .select()
      .from(vectorDocuments)
      .where(eq(vectorDocuments.vectorId, vectorId))
      .get();

    // 3) metaPayload：用于后续过滤/调试（当前不参与调度）。
    const metaPayload = JSON.stringify(await this.buildMetaForNode(nodeId));

    if (existing) {
      // 幂等判断：内容未变则不重置状态机。
      if (existing.textHash === textHash) {
        logger.debug({ vectorId }, "Vector document up to date (hash match)");
        return { vectorDocumentId: existing.id, vectorId };
      }

      // 内容变化：重置 embedding/index 两段状态机为 pending，让调度器推进。
      const updated = db
        .update(vectorDocuments)
        .set({
          docType: "context_node",
          refId: nodeId,
          textHash,
          embedding: null,
          metaPayload,
          embeddingStatus: "pending",
          embeddingAttempts: 0,
          embeddingNextRunAt: null,
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          errorMessage: null,
          errorCode: null,
          updatedAt: Date.now(),
        })
        .where(eq(vectorDocuments.id, existing.id))
        .returning()
        .get();

      if (!updated) {
        throw new Error(`Failed to update vector document for ${vectorId}`);
      }

      logger.info({ vectorId, docId: updated.id }, "Updated vector document (content changed)");
      emitVectorDocumentsDirty({
        reason: "upsert_for_context_node",
        vectorDocumentId: updated.id,
        nodeId,
      });
      return { vectorDocumentId: updated.id, vectorId };
    } else {
      // 新建：初始即为 pending，由调度器推进 embedding/index。
      const inserted = db
        .insert(vectorDocuments)
        .values({
          vectorId,
          docType: "context_node",
          refId: nodeId,
          textHash,
          metaPayload,
          embeddingStatus: "pending",
          indexStatus: "pending",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .returning()
        .get();

      if (!inserted) {
        throw new Error(`Failed to create vector document for ${vectorId}`);
      }

      logger.info({ vectorId, docId: inserted.id }, "Created new vector document");
      emitVectorDocumentsDirty({
        reason: "upsert_for_context_node",
        vectorDocumentId: inserted.id,
        nodeId,
      });
      return { vectorDocumentId: inserted.id, vectorId };
    }
  }

  /**
   * Build canonical text representation for embedding
   */
  async buildTextForNode(nodeId: number): Promise<string> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    // Format:
    // Title: ...
    // Kind: ...
    // Summary: ...
    // Keywords: ...
    // Entities: ...

    const parts: string[] = [];
    parts.push(`Title: ${node.title}`);
    parts.push(`Kind: ${node.kind}`);
    parts.push(`Summary: ${node.summary}`);

    if (node.keywords) {
      try {
        const keywords = JSON.parse(node.keywords);
        if (Array.isArray(keywords) && keywords.length > 0) {
          parts.push(`Keywords: ${keywords.join(", ")}`);
        }
      } catch {
        // ignore parse error
      }
    }

    if (node.entities) {
      try {
        const entities = JSON.parse(node.entities);
        if (Array.isArray(entities) && entities.length > 0) {
          const names = entities.map((e: { name?: string }) => e.name).filter(Boolean);
          if (names.length > 0) {
            parts.push(`Entities: ${names.join(", ")}`);
          }
        }
      } catch {
        // ignore parse error
      }
    }

    return parts.join("\n");
  }

  /**
   * Build metadata payload
   */
  private async buildMetaForNode(nodeId: number): Promise<Record<string, unknown>> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    // Basic metadata for filtering
    const meta: Record<string, unknown> = {
      nodeId: node.id,
      kind: node.kind,
      threadId: node.threadId,
      eventTime: node.eventTime,
    };

    // Entities: keep a small, unique list of names to avoid oversized payloads
    if (node.entities) {
      try {
        const parsed = JSON.parse(node.entities) as Array<{ name?: string }> | null;
        if (Array.isArray(parsed)) {
          const names: string[] = [];
          const seen = new Set<string>();
          for (const e of parsed) {
            const name = (e?.name ?? "").trim();
            if (!name) continue;
            const key = name.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            names.push(name);
            if (names.length >= 20) break; // cap to avoid bloating payload
          }
          meta.entities = names;
        }
      } catch {
        // ignore parse error
      }
    }

    return meta;
  }

  /**
   * Compute SHA-256 hash of text
   */
  private computeHash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }
}

export const vectorDocumentService = new VectorDocumentService();
