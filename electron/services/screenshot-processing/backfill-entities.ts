import { eq, gte, and, asc } from "drizzle-orm";
import { getDb } from "../../database";
import { contextNodes } from "../../database/schema";
import { entityService } from "./entity-service";
import { getLogger } from "../logger";

const logger = getLogger("backfill-entities");

/**
 * Backfill entities for existing event nodes.
 * This script iterates through all event nodes in the database and
 * ensures they have proper entity_profile nodes, aliases, and edges.
 *
 * @param startId - Optional starting node ID for partial backfill
 * @param pageSize - Number of records to process in each batch
 */
export async function backfillEntities(startId: number = 0, pageSize: number = 100): Promise<void> {
  const db = getDb();

  logger.info({ startId, pageSize }, "Starting entities backfill");

  let currentId = startId;
  let successCount = 0;
  let failCount = 0;
  let totalProcessed = 0;

  while (true) {
    const eventNodes = db
      .select({
        id: contextNodes.id,
        entities: contextNodes.entities,
      })
      .from(contextNodes)
      .where(and(eq(contextNodes.kind, "event"), gte(contextNodes.id, currentId)))
      .orderBy(asc(contextNodes.id))
      .limit(pageSize)
      .all();

    if (eventNodes.length === 0) break;

    for (const node of eventNodes) {
      try {
        if (node.entities) {
          const entities = JSON.parse(node.entities);
          if (Array.isArray(entities) && entities.length > 0) {
            await entityService.syncEventEntityMentions(node.id, entities, "llm");
            successCount++;
          }
        }
      } catch (error) {
        failCount++;
        logger.error(
          { nodeId: node.id, error: error instanceof Error ? error.message : String(error) },
          "Failed to backfill node"
        );
      }
      totalProcessed++;
      currentId = node.id + 1;
    }

    logger.debug({ currentId, successCount, failCount }, "Backfill iteration complete");
  }

  logger.info(
    { totalProcessed, success: successCount, failed: failCount },
    "Entities backfill completed"
  );
}
