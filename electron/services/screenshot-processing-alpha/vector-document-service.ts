import crypto from "node:crypto";
import { eq } from "drizzle-orm";

import { getDb } from "../../database";
import { contextNodes, vectorDocuments } from "../../database/schema";
import { getLogger } from "../logger";
import { screenshotProcessingEventBus } from "./event-bus";

const logger = getLogger("vector-document-service");

export class VectorDocumentService {
  async upsertForContextNode(
    nodeId: number
  ): Promise<{ vectorDocumentId: number; vectorId: string }> {
    const db = getDb();
    const now = Date.now();

    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();
    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    const textContent = await this.buildTextForNode(nodeId);
    const textHash = this.computeHash(textContent);
    const vectorId = `node:${nodeId}`;

    const metaPayload = JSON.stringify(await this.buildMetaForNode(nodeId));

    const existing = db
      .select()
      .from(vectorDocuments)
      .where(eq(vectorDocuments.vectorId, vectorId))
      .get();

    if (existing) {
      if (existing.textHash === textHash) {
        const updated = db
          .update(vectorDocuments)
          .set({
            refId: nodeId,
            docType: "context_node",
            metaPayload,
            updatedAt: now,
          })
          .where(eq(vectorDocuments.id, existing.id))
          .returning({ id: vectorDocuments.id })
          .get();

        if (!updated) {
          throw new Error(`Failed to refresh vector document meta for ${vectorId}`);
        }

        logger.debug({ vectorId }, "Vector document up to date (hash match); meta refreshed");
        return { vectorDocumentId: existing.id, vectorId };
      }

      const updated = db
        .update(vectorDocuments)
        .set({
          docType: "context_node",
          refId: nodeId,
          textContent,
          textHash,
          embedding: null,
          metaPayload,
          embeddingStatus: "pending",
          embeddingAttempts: 0,
          embeddingNextRunAt: null,
          indexStatus: "pending",
          indexAttempts: 0,
          indexNextRunAt: null,
          updatedAt: now,
        })
        .where(eq(vectorDocuments.id, existing.id))
        .returning({ id: vectorDocuments.id })
        .get();

      if (!updated) {
        throw new Error(`Failed to update vector document for ${vectorId}`);
      }

      screenshotProcessingEventBus.emit("vector-documents:dirty", {
        type: "vector-documents:dirty",
        timestamp: now,
        reason: "upsert_for_context_node",
        vectorDocumentId: updated.id,
        nodeId,
      });

      logger.info({ nodeId, vectorDocumentId: updated.id }, "Updated vector document");
      return { vectorDocumentId: updated.id, vectorId };
    }

    const inserted = db
      .insert(vectorDocuments)
      .values({
        vectorId,
        docType: "context_node",
        refId: nodeId,
        textContent,
        textHash,
        metaPayload,
        embedding: null,
        embeddingStatus: "pending",
        embeddingAttempts: 0,
        embeddingNextRunAt: null,
        indexStatus: "pending",
        indexAttempts: 0,
        indexNextRunAt: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: vectorDocuments.id })
      .get();

    if (!inserted) {
      throw new Error(`Failed to create vector document for ${vectorId}`);
    }

    screenshotProcessingEventBus.emit("vector-documents:dirty", {
      type: "vector-documents:dirty",
      timestamp: now,
      reason: "upsert_for_context_node",
      vectorDocumentId: inserted.id,
      nodeId,
    });

    logger.info({ nodeId, vectorDocumentId: inserted.id }, "Created vector document");
    return { vectorDocumentId: inserted.id, vectorId };
  }

  async buildTextForNode(nodeId: number): Promise<string> {
    const db = getDb();
    const node = db.select().from(contextNodes).where(eq(contextNodes.id, nodeId)).get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    const parts: string[] = [];
    parts.push(`Title: ${node.title}`);
    parts.push(`Summary: ${node.summary}`);

    if (node.keywords) {
      try {
        const keywords = JSON.parse(node.keywords) as unknown;
        if (Array.isArray(keywords) && keywords.length > 0) {
          parts.push(`Keywords: ${keywords.join(", ")}`);
        }
      } catch {
        // ignore parse error
      }
    }

    if (node.knowledge) {
      parts.push(`Knowledge: ${node.knowledge}`);
    }

    if (node.stateSnapshot) {
      parts.push(`StateSnapshot: ${node.stateSnapshot}`);
    }

    return parts.join("\n");
  }

  private async buildMetaForNode(nodeId: number): Promise<Record<string, unknown>> {
    const db = getDb();
    const node = db
      .select({
        id: contextNodes.id,
        threadId: contextNodes.threadId,
        eventTime: contextNodes.eventTime,
        batchId: contextNodes.batchId,
      })
      .from(contextNodes)
      .where(eq(contextNodes.id, nodeId))
      .get();

    if (!node) {
      throw new Error(`Context node not found: ${nodeId}`);
    }

    return {
      nodeId: node.id,
      kind: "event",
      batchId: node.batchId,
      threadId: node.threadId,
      eventTime: node.eventTime,
    };
  }

  private computeHash(text: string): string {
    return crypto.createHash("sha256").update(text).digest("hex");
  }
}

export const vectorDocumentService = new VectorDocumentService();
