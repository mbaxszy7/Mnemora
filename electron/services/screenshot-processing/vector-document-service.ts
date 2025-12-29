import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../../database";
import { vectorDocuments, contextNodes } from "../../database/schema";
import { getLogger } from "../logger";

const logger = getLogger("vector-document-service");

/**
 * Service for managing vector documents (embeddings foundation)
 */
export class VectorDocumentService {
  /**
   * Upsert a vector document for a context node
   *
   * - Builds canonical text representation
   * - Computes hash for deduplication
   * - If content changed (hash mismatch) or new:
   *   - Creates/Updates vector_documents record
   *   - Resets embeddingStatus/indexStatus to 'pending'
   *
   * @param nodeId - The context node ID
   * @returns The vector document ID and vector ID
   */
  async upsertForContextNode(
    nodeId: number
  ): Promise<{ vectorDocumentId: number; vectorId: string }> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    // 1. Build text and hash
    const textContent = await this.buildTextForNode(nodeId); // currently sync-ish but async interface for future
    const textHash = this.computeHash(textContent);
    const vectorId = `node:${nodeId}`;

    // 2. Check existing document
    const existing = db
      .select()
      .from(vectorDocuments)
      .where(eq(vectorDocuments.vectorId, vectorId))
      .get();

    // 3. Prepare metadata
    const metaPayload = JSON.stringify(await this.buildMetaForNode(nodeId));

    if (existing) {
      // Idempotency check
      if (existing.textHash === textHash) {
        logger.debug({ vectorId }, "Vector document up to date (hash match)");
        return { vectorDocumentId: existing.id, vectorId };
      }

      // Update existing
      const updated = db
        .update(vectorDocuments)
        .set({
          docType: "context_node",
          refId: nodeId,
          textHash,
          embedding: null, // Invalidate old embedding
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
      return { vectorDocumentId: updated.id, vectorId };
    } else {
      // Create new
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
  async buildMetaForNode(nodeId: number): Promise<Record<string, unknown>> {
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
