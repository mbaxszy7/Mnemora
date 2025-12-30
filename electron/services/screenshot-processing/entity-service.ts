import { eq, and, sql } from "drizzle-orm";
import { getDb } from "../../database";
import { contextNodes, entityAliases, contextEdges } from "../../database/schema";
import type { AliasSource } from "../../database/schema";
import { getLogger } from "../logger";
import { contextGraphService } from "./context-graph-service";
import type { EntityRef } from "../../../shared/context-types";

const logger = getLogger("entity-service");

/**
 * EntityService handles normalization, resolution, and relationship management
 * for entities in the context graph.
 */
export class EntityService {
  /**
   * Normalize an alias string for disambiguation.
   * Collapses whitespace, trims, and converts to lowercase.
   */
  normalizeAlias(name: string): string {
    return name.trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * Resolve a list of entity references to stable entity_profile nodes.
   * If an entity doesn't exist, it will be created.
   * Updates the references with their corresponding entityId.
   *
   * @param entityRefs - List of entity references to resolve
   * @param source - Source of the entity information
   * @returns Updated entity references with entityIds
   */
  async resolveEntities(entityRefs: EntityRef[], source: AliasSource): Promise<EntityRef[]> {
    const db = getDb();
    const resolvedRefs: EntityRef[] = [];

    for (const ref of entityRefs) {
      const normalizedName = this.normalizeAlias(ref.name);
      if (!normalizedName) continue;

      try {
        let entityId: number | undefined = ref.entityId;

        // 1. If entityId is provided, verify it exists and is an entity_profile
        if (entityId) {
          const existingNode = db
            .select({ id: contextNodes.id, kind: contextNodes.kind })
            .from(contextNodes)
            .where(eq(contextNodes.id, entityId))
            .get();

          if (!existingNode || existingNode.kind !== "entity_profile") {
            logger.warn(
              { entityId, name: ref.name },
              "Invalid entityId provided, falling back to resolution"
            );
            entityId = undefined;
          }
        }

        // 2. If no valid entityId, check entity_aliases table
        if (!entityId) {
          // Prioritize manual > llm > vlm > ocr, then higher confidence, then earlier createdAt (stable)
          const sourcePriority = sql<number>`
            CASE ${entityAliases.source}
              WHEN 'manual' THEN 1
              WHEN 'llm' THEN 2
              WHEN 'vlm' THEN 3
              WHEN 'ocr' THEN 4
              ELSE 5
            END
          `;

          const aliasMatch = db
            .select({ entityId: entityAliases.entityId })
            .from(entityAliases)
            .where(eq(entityAliases.alias, normalizedName))
            .orderBy(
              sourcePriority,
              sql`${entityAliases.confidence} DESC`,
              sql`${entityAliases.createdAt} ASC`
            )
            .get();

          if (aliasMatch) {
            entityId = aliasMatch.entityId;
          }
        }

        // 3. If still no entityId, check context_nodes for exact title match (canonical name)
        if (!entityId) {
          const nodeMatch = db
            .select({ id: contextNodes.id })
            .from(contextNodes)
            .where(
              and(
                eq(contextNodes.kind, "entity_profile"),
                sql`LOWER(${contextNodes.title}) = ${normalizedName}`
              )
            )
            .get();

          if (nodeMatch) {
            entityId = nodeMatch.id;
          }
        }

        // 4. If still no entityId, create a new entity_profile node
        if (!entityId) {
          const newIdStr = await contextGraphService.createNode({
            kind: "entity_profile",
            title: ref.name, // Use original casing for title
            summary: `Entity: ${ref.name}`,
            importance: 5,
            confidence: Math.floor((ref.confidence ?? 0.5) * 10),
            entities: [], // entity_profile itself doesn't mention other entities in MVP
            keywords: [],
          });
          entityId = parseInt(newIdStr, 10);
          logger.info({ entityId, name: ref.name }, "Created new entity_profile node");
        }

        // 5. Ensure the normalized alias exists for this entity
        db.insert(entityAliases)
          .values({
            entityId: entityId!,
            alias: normalizedName,
            source,
            createdAt: Date.now(),
            confidence: ref.confidence ?? 1.0,
          })
          .onConflictDoNothing()
          .run();

        // Get canonical name for the UI
        const canonicalNode = db
          .select({ title: contextNodes.title })
          .from(contextNodes)
          .where(eq(contextNodes.id, entityId!))
          .get();

        resolvedRefs.push({
          ...ref,
          entityId,
          name: canonicalNode?.title ?? ref.name,
        });
      } catch (error) {
        logger.error(
          { name: ref.name, error: error instanceof Error ? error.message : String(error) },
          "Failed to resolve entity"
        );
        resolvedRefs.push(ref);
      }
    }

    return resolvedRefs;
  }

  /**
   * Synchronize entity mentions for an event node.
   * Resolves entities, builds edges, and updates the event node's entities field.
   *
   * @param eventNodeId - ID of the event node
   * @param entityRefs - List of entity references mentioned in the event
   * @param source - Source of the mentions
   */
  async syncEventEntityMentions(
    eventNodeId: number,
    entityRefs: EntityRef[],
    source: AliasSource
  ): Promise<void> {
    if (!entityRefs || entityRefs.length === 0) return;

    logger.debug({ eventNodeId, count: entityRefs.length }, "Syncing event entity mentions");

    const db = getDb();

    // 0. Guard: Ensure fromNodeId is an event
    const fromNode = db
      .select({ kind: contextNodes.kind })
      .from(contextNodes)
      .where(eq(contextNodes.id, eventNodeId))
      .get();

    if (!fromNode || fromNode.kind !== "event") {
      logger.warn(
        { eventNodeId, kind: fromNode?.kind },
        "Skipping syncEventEntityMentions for non-event node"
      );
      return;
    }

    // 1. Resolve all entities to get stable IDs
    const resolvedRefs = await this.resolveEntities(entityRefs, source);

    // 2. Create event_mentions_entity edges
    for (const ref of resolvedRefs) {
      if (ref.entityId) {
        try {
          db.insert(contextEdges)
            .values({
              fromNodeId: eventNodeId,
              toNodeId: ref.entityId,
              edgeType: "event_mentions_entity",
              createdAt: Date.now(),
            })
            .onConflictDoNothing()
            .run();
        } catch (error) {
          logger.warn({ eventNodeId, entityId: ref.entityId, error }, "Failed to create edge");
        }
      }
    }

    // 3. Update the event node with resolved entity references (including entityIds)
    try {
      await contextGraphService.updateNode(eventNodeId.toString(), {
        entities: resolvedRefs,
      });
    } catch (error) {
      logger.error({ eventNodeId, error }, "Failed to update event node entities");
    }
  }
}

export const entityService = new EntityService();
