import { eq } from "drizzle-orm";

import { getDb } from "../../database";
import { contextNodes, contextScreenshotLinks } from "../../database/schema";
import { getLogger } from "../logger";
import type { UpsertNodeInput } from "./types";

const logger = getLogger("context-node-service");

export class ContextNodeService {
  async upsertNodeForScreenshot(input: UpsertNodeInput): Promise<number> {
    const db = getDb();
    const now = Date.now();

    const existingLink = db
      .select({ nodeId: contextScreenshotLinks.nodeId })
      .from(contextScreenshotLinks)
      .where(eq(contextScreenshotLinks.screenshotId, input.screenshotId))
      .get();

    const nodeRecord = {
      batchId: input.batchId,
      title: input.title,
      summary: input.summary,
      eventTime: input.screenshotTs,
      threadId: null,
      threadSnapshot: null,
      appContext: JSON.stringify(input.appContext),
      knowledge: input.knowledge ? JSON.stringify(input.knowledge) : null,
      stateSnapshot: input.stateSnapshot ? JSON.stringify(input.stateSnapshot) : null,
      actionItems: input.actionItems ? JSON.stringify(input.actionItems) : null,
      uiTextSnippets: JSON.stringify(input.uiTextSnippets ?? []),
      importance: input.importance,
      confidence: input.confidence,
      keywords: JSON.stringify(input.keywords ?? []),
      entities: JSON.stringify(input.entities ?? []),
      createdAt: now,
      updatedAt: now,
    };

    if (existingLink) {
      db.update(contextNodes)
        .set({
          title: nodeRecord.title,
          summary: nodeRecord.summary,
          eventTime: nodeRecord.eventTime,
          appContext: nodeRecord.appContext,
          knowledge: nodeRecord.knowledge,
          stateSnapshot: nodeRecord.stateSnapshot,
          actionItems: nodeRecord.actionItems,
          uiTextSnippets: nodeRecord.uiTextSnippets,
          importance: nodeRecord.importance,
          confidence: nodeRecord.confidence,
          keywords: nodeRecord.keywords,
          entities: nodeRecord.entities,
          updatedAt: now,
        })
        .where(eq(contextNodes.id, existingLink.nodeId))
        .run();

      return existingLink.nodeId;
    }

    const inserted = db
      .insert(contextNodes)
      .values(nodeRecord)
      .returning({ id: contextNodes.id })
      .get();

    if (!inserted) {
      throw new Error("Failed to insert context node");
    }

    db.insert(contextScreenshotLinks)
      .values({
        nodeId: inserted.id,
        screenshotId: input.screenshotId,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [contextScreenshotLinks.nodeId, contextScreenshotLinks.screenshotId],
      })
      .run();

    logger.debug(
      { nodeId: inserted.id, screenshotId: input.screenshotId },
      "Upserted context node"
    );

    return inserted.id;
  }
}

export const contextNodeService = new ContextNodeService();
