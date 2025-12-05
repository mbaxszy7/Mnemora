import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * LLM Configuration table
 * Stores LLM API configuration for unified or separate mode
 * Only one row should exist (singleton configuration)
 */
export const llmConfig = sqliteTable("llm_config", {
  id: integer("id").primaryKey({ autoIncrement: true }),

  // Configuration mode: 'unified' or 'separate'
  mode: text("mode", { enum: ["unified", "separate"] }).notNull(),

  // Unified mode configuration (used when mode = 'unified')
  unifiedBaseUrl: text("unified_base_url"),
  unifiedApiKey: text("unified_api_key"), // base64 encoded
  unifiedModel: text("unified_model"),

  // VLM configuration (used when mode = 'separate')
  vlmBaseUrl: text("vlm_base_url"),
  vlmApiKey: text("vlm_api_key"), // base64 encoded
  vlmModel: text("vlm_model"),

  // Text LLM configuration (used when mode = 'separate')
  textLlmBaseUrl: text("text_llm_base_url"),
  textLlmApiKey: text("text_llm_api_key"), // base64 encoded
  textLlmModel: text("text_llm_model"),

  // Embedding LLM configuration (used when mode = 'separate')
  embeddingBaseUrl: text("embedding_base_url"),
  embeddingApiKey: text("embedding_api_key"), // base64 encoded
  embeddingModel: text("embedding_model"),

  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ============================================================================
// Type Exports
// ============================================================================

export type LLMConfigRecord = typeof llmConfig.$inferSelect;
export type NewLLMConfigRecord = typeof llmConfig.$inferInsert;
