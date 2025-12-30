import crypto from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../../database";
import { llmUsageEvents, type NewLLMUsageEventRecord } from "../../database/schema";
import { getLogger } from "../logger";
import { llmConfigService } from "../llm-config-service";
import type { LLMConfig } from "@shared/llm-config-types";

const logger = getLogger("llm-usage-service");

export interface UsageTimeRange {
  fromTs: number;
  toTs: number;
}

export class LLMUsageService {
  private static instance: LLMUsageService | null = null;

  private constructor() {}

  static getInstance(): LLMUsageService {
    if (!LLMUsageService.instance) {
      LLMUsageService.instance = new LLMUsageService();
    }
    return LLMUsageService.instance;
  }

  /**
   * Calculate a stable hash for the current LLM configuration
   * This is used to "reset" stats when the user changes providers/models
   */
  async getConfigHash(config?: LLMConfig): Promise<string> {
    // If no config provided, load from service
    if (!config) {
      const loaded = await llmConfigService.loadConfiguration();
      if (!loaded) return "unconfigured";
      config = loaded;
    }

    // Create a string representation of the critical fields
    let sig = "";
    if (config.mode === "unified") {
      sig = `unified:${config.config.baseUrl}:${config.config.model}`;
      // Note: we do NOT include API Key in the hash to avoid security issues,
      // but if the user changes API key for the same endpoint, we consider it the same "config"
      // for usage tracking purposes? Or should we?
      // The requirement says: "mode + endpointRole + baseUrl + model".
      // Let's stick to that. Changing API key usually means same Account, so typically we want to Reset if Account changes?
      // But we can't easily detect Account change without Key change.
      // However, including Key in hash might be sensitive if the hash is leaked?
      // Hash is one-way. But MD5/SHA256 of Key is essentially a Key fingerprint.
      // Let's include a partial key or just rely on Url/Model.
      // Requirement: "configHash (string; used for config change reset ... e.g. mode + endpointRole + baseUrl + model)"
      // It didn't mention API Key. So I will skip API Key to be safe and simple.
    } else {
      // Separate mode: simplified hash that changes if ANY of the 3 capabilities changes
      // This might be too aggressive (resets ALL stats if just embedding changes?),
      // but "configHash" is per-event in the schema!
      // Wait, the schema has `configHash` column in `llm_usage_events`.
      // So each event is tagged with the config active AT THAT MOMENT.
      // The UI filter will likely select "Current Config Hash" to show stats.
      // So if I change Embedding model, Text stats shouldn't disappear?
      // The requirement says: "UI default only shows 'latest configHash'".
      // If I have a global "latest configHash", it implies one hash for the whole system.
      // If I change Embedding, the global hash changes, so Text stats (which didn't change provider) would also "reset" in the UI?
      // That seems suboptimal but compliant with "UI default only shows latest configHash".
      // Let's implement global hash for now for simplicity.

      sig =
        `separate` +
        `|vlm:${config.vlm.baseUrl}:${config.vlm.model}` +
        `|text:${config.textLlm.baseUrl}:${config.textLlm.model}` +
        `|embed:${config.embeddingLlm.baseUrl}:${config.embeddingLlm.model}`;
    }

    return crypto.createHash("sha256").update(sig).digest("hex").slice(0, 16);
  }

  /**
   * Log an LLM usage event
   * Fire-and-forget style (returns Promise but usually caller doesn't await for strict completion)
   */
  async logEvent(event: Omit<NewLLMUsageEventRecord, "configHash" | "id">): Promise<void> {
    try {
      // Get current config hash
      const configHash = await this.getConfigHash();

      const record: NewLLMUsageEventRecord = {
        ...event,
        configHash,
      };

      const db = getDb();
      await db.insert(llmUsageEvents).values(record).run();

      // We could update rollups here, but for MVP we will stick to logging events
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Failed to log LLM usage event"
      );
      // Do not throw, to avoid breaking the main application flow
    }
  }

  /**
   * Get usage summary for a time range, optionally filtered by configHash
   */
  async getUsageSummary(range: UsageTimeRange, configHash?: string) {
    const db = getDb();

    // Base conditions
    const conditions = [gte(llmUsageEvents.ts, range.fromTs), lte(llmUsageEvents.ts, range.toTs)];

    if (configHash) {
      conditions.push(eq(llmUsageEvents.configHash, configHash));
    }

    // Aggregations
    const result = await db
      .select({
        totalTokens: sql<number>`sum(${llmUsageEvents.totalTokens})`,
        requestCount: sql<number>`count(*)`,
        succeededCount: sql<number>`sum(case when ${llmUsageEvents.status} = 'succeeded' then 1 else 0 end)`,
        failedCount: sql<number>`sum(case when ${llmUsageEvents.status} = 'failed' then 1 else 0 end)`,
      })
      .from(llmUsageEvents)
      .where(and(...conditions))
      .get();

    return {
      totalTokens: result?.totalTokens ?? 0,
      requestCount: result?.requestCount ?? 0,
      succeededCount: result?.succeededCount ?? 0,
      failedCount: result?.failedCount ?? 0,
    };
  }

  /**
   * Get usage breakdown by model
   */
  async getBreakdownByModel(range: UsageTimeRange, configHash?: string) {
    const db = getDb();
    const conditions = [gte(llmUsageEvents.ts, range.fromTs), lte(llmUsageEvents.ts, range.toTs)];
    if (configHash) conditions.push(eq(llmUsageEvents.configHash, configHash));

    return db
      .select({
        model: llmUsageEvents.model,
        capability: llmUsageEvents.capability,
        requestCount: sql<number>`count(*)`,
        totalTokens: sql<number>`sum(${llmUsageEvents.totalTokens})`,
        succeededCount: sql<number>`sum(case when ${llmUsageEvents.status} = 'succeeded' then 1 else 0 end)`,
      })
      .from(llmUsageEvents)
      .where(and(...conditions))
      .groupBy(llmUsageEvents.model, llmUsageEvents.capability)
      .orderBy(desc(sql`sum(${llmUsageEvents.totalTokens})`))
      .all();
  }

  /**
   * Get daily usage stats for charts
   * Aggregates events on the fly (MVP) or queries rollups
   */
  async getDailyUsage(range: UsageTimeRange, configHash?: string) {
    const db = getDb();
    const conditions = [gte(llmUsageEvents.ts, range.fromTs), lte(llmUsageEvents.ts, range.toTs)];
    if (configHash) conditions.push(eq(llmUsageEvents.configHash, configHash));

    // SQLite date format: %Y-%m-%d
    // Aggregating by day
    const dailyStats = await db
      .select({
        date: sql<string>`strftime('%Y-%m-%d', ${llmUsageEvents.ts} / 1000, 'unixepoch', 'localtime')`,
        totalTokens: sql<number>`sum(${llmUsageEvents.totalTokens})`,
      })
      .from(llmUsageEvents)
      .where(and(...conditions))
      .groupBy(sql`strftime('%Y-%m-%d', ${llmUsageEvents.ts} / 1000, 'unixepoch', 'localtime')`)
      .orderBy(sql`strftime('%Y-%m-%d', ${llmUsageEvents.ts} / 1000, 'unixepoch', 'localtime')`)
      .all();

    return dailyStats.map((stat) => ({
      date: stat.date,
      totalTokens: stat.totalTokens ?? 0,
    }));
  }
}

export const llmUsageService = LLMUsageService.getInstance();
