import { sqliteTable, text, integer, blob, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const STORAGE_STATE_VALUES = ["ephemeral", "persisted", "deleted"] as const;

// Base processing status values (shared by VLM, OCR, Embedding, Index, ActivityEvent)
export const PROCESSING_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;

// Derived status arrays - all use the same base values
export const VLM_STATUS_VALUES = PROCESSING_STATUS_VALUES;
export const OCR_STATUS_VALUES = PROCESSING_STATUS_VALUES;
export const EMBEDDING_STATUS_VALUES = PROCESSING_STATUS_VALUES;
export const INDEX_STATUS_VALUES = PROCESSING_STATUS_VALUES;
export const ACTIVITY_EVENT_STATUS_VALUES = PROCESSING_STATUS_VALUES;

// Thread has different semantics
export const THREAD_STATUS_VALUES = ["active", "inactive", "closed"] as const;

// Summary extends base with "no_data" (cannot use spread due to drizzle-orm tuple type requirement)
export const SUMMARY_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "no_data",
  "failed",
  "failed_permanent",
] as const;

export const LLM_USAGE_CAPABILITY_VALUES = ["vlm", "text", "embedding"] as const;
export const LLM_USAGE_STATUS_VALUES = ["succeeded", "failed"] as const;
export const LLM_TOKEN_USAGE_STATUS_VALUES = ["present", "missing"] as const;

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

  // UI / Localization
  language: text("language").notNull().default("en"),

  // Timestamps
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ============================================================================
// Screenshot Processing Tables
// ============================================================================
export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    originKey: text("origin_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    currentPhase: text("current_phase"),
    currentFocus: text("current_focus"),
    status: text("status", {
      enum: THREAD_STATUS_VALUES,
    })
      .notNull()
      .default("active"),
    startTime: integer("start_time").notNull(),
    lastActiveAt: integer("last_active_at").notNull(),
    durationMs: integer("duration_ms").notNull().default(0),
    nodeCount: integer("node_count").notNull().default(0),
    apps: text("apps_json").notNull().default("[]"),
    mainProject: text("main_project"),
    keyEntities: text("key_entities_json").notNull().default("[]"),
    milestones: text("milestones_json"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_threads_last_active_at").on(table.lastActiveAt),
    index("idx_threads_status").on(table.status),
    uniqueIndex("idx_threads_origin_key").on(table.originKey),
  ]
);

export const screenshotsFts = sqliteTable("screenshots_fts", {
  rowid: integer("rowid"),
  ocrText: text("ocr_text"),
});

/**
 * Batches table
 * Stores batch processing jobs for VLM analysis
 */
export const batches = sqliteTable(
  "batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Batch content
    screenshotIds: text("screenshot_ids").notNull(), // JSON array of screenshot IDs

    // Batch identification
    batchId: text("batch_id").notNull().unique(),
    sourceKey: text("source_key").notNull(),

    tsStart: integer("ts_start").notNull(),
    tsEnd: integer("ts_end").notNull(),

    // Processing state: VLM
    vlmStatus: text("vlm_status", {
      enum: VLM_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    vlmAttempts: integer("vlm_attempts").notNull().default(0),
    vlmNextRunAt: integer("vlm_next_run_at"),
    vlmErrorMessage: text("vlm_error_message"),

    // Processing state: Thread LLM
    threadLlmStatus: text("thread_llm_status", {
      enum: VLM_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    threadLlmAttempts: integer("thread_llm_attempts").notNull().default(0),
    threadLlmNextRunAt: integer("thread_llm_next_run_at"),
    threadLlmErrorMessage: text("thread_llm_error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_batches_vlm_status").on(table.vlmStatus),
    index("idx_batches_thread_llm_status").on(table.threadLlmStatus),
    index("idx_batches_source_key").on(table.sourceKey),
  ]
);

/**
 * Screenshots table
 * Stores captured screenshots with metadata, evidence, and processing status
 */
export const screenshots = sqliteTable(
  "screenshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Source identification
    sourceKey: text("source_key").notNull(), // format: screen:<id> or window:<id>
    ts: integer("ts").notNull(), // capture timestamp in milliseconds

    // Image metadata
    phash: text("phash").notNull(), // perceptual hash (16 hex chars)
    width: integer("width"),
    height: integer("height"),

    // Evidence fields
    appHint: text("app_hint"),
    windowTitle: text("window_title"),
    ocrText: text("ocr_text"), // limited to 8k characters
    ocrStatus: text("ocr_status", {
      enum: OCR_STATUS_VALUES,
    }),
    ocrAttempts: integer("ocr_attempts").notNull().default(0),
    ocrNextRunAt: integer("ocr_next_run_at"),

    batchId: integer("batch_id").references(() => batches.id),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),

    filePath: text("file_path"),
    storageState: text("storage_state", {
      enum: STORAGE_STATE_VALUES,
    }),
  },
  (table) => [
    index("idx_screenshots_source_key").on(table.sourceKey),
    index("idx_screenshots_ts").on(table.ts),
    index("idx_screenshots_batch_id").on(table.batchId),
    index("idx_screenshots_ocr_status").on(table.ocrStatus),
  ]
);

/**
 * Context Nodes table
 * Stores nodes in the context graph (events, knowledge, state, procedures, plans, entities)
 */
export const contextNodes = sqliteTable(
  "context_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Batch linkage
    batchId: integer("batch_id")
      .notNull()
      .references(() => batches.id),

    // Core content
    title: text("title").notNull(),
    summary: text("summary").notNull(),

    // Timing
    eventTime: integer("event_time").notNull(),

    // Thread linkage
    threadId: text("thread_id").references(() => threads.id),
    threadSnapshot: text("thread_snapshot_json"),

    // App context and extracted knowledge/state
    //  { appHint, windowTitle, sourceKey }
    appContext: text("app_context_json").notNull(),
    //  { contentType, sourceUrl, projectOrLibrary, keyInsights, language, textRegion?: { box: { top, left, width, height }, confidence } }
    knowledge: text("knowledge_json"),
    //  { subjectType, subject, currentState, metrics?, issue?: { detected: boolean, type: "error"|"bug"|"blocker"|"question"|"warning", description: string, severity: 1-5 } }
    stateSnapshot: text("state_snapshot_json"),
    //  string[]
    uiTextSnippets: text("ui_text_snippets_json"),

    // Scoring
    importance: integer("importance").notNull().default(5), // 0-10 scale
    confidence: integer("confidence").notNull().default(5), // 0-10 scale

    // Keywords
    keywords: text("keywords_json").notNull().default("[]"),

    // Entities
    entities: text("entities_json").notNull().default("[]"),

    // Processing status
    embeddingStatus: text("embedding_status", {
      enum: EMBEDDING_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    embeddingAttempts: integer("embedding_attempts").notNull().default(0),
    embeddingNextRunAt: integer("embedding_next_run_at"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_context_nodes_batch_id").on(table.batchId),
    index("idx_context_nodes_thread_id").on(table.threadId),
    index("idx_context_nodes_event_time").on(table.eventTime),
    index("idx_context_nodes_embedding_status").on(table.embeddingStatus),
  ]
);

export const contextScreenshotLinks = sqliteTable(
  "context_screenshot_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: integer("node_id")
      .notNull()
      .references(() => contextNodes.id),
    screenshotId: integer("screenshot_id")
      .notNull()
      .references(() => screenshots.id),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_csl_node").on(table.nodeId),
    index("idx_csl_screenshot").on(table.screenshotId),
    uniqueIndex("idx_csl_unique").on(table.nodeId, table.screenshotId),
  ]
);

/**
 * Vector Documents table
 * Stores embeddings and metadata for semantic search
 */
export const vectorDocuments = sqliteTable(
  "vector_documents",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Vector identification
    vectorId: text("vector_id").notNull().unique(),
    docType: text("doc_type").notNull(),
    refId: integer("ref_id").notNull(), // references context_nodes.id

    // Content
    textContent: text("text_content").notNull(),
    textHash: text("text_hash").notNull(),
    metaPayload: text("meta_payload_json"),

    // Embedding
    embedding: blob("embedding"),

    // Processing status
    embeddingStatus: text("embedding_status", {
      enum: EMBEDDING_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    embeddingAttempts: integer("embedding_attempts").notNull().default(0),
    embeddingNextRunAt: integer("embedding_next_run_at"),
    indexStatus: text("index_status", {
      enum: INDEX_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    indexAttempts: integer("index_attempts").notNull().default(0),
    indexNextRunAt: integer("index_next_run_at"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_vd_embedding_status").on(table.embeddingStatus),
    index("idx_vd_index_status").on(table.indexStatus),
    index("idx_vd_text_hash").on(table.textHash),
  ]
);

/**
 * Activity Summaries table
 * Stores periodic activity summaries for time windows (20 min each)
 */
export const activitySummaries = sqliteTable(
  "activity_summaries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Time window
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),

    // Processing status
    status: text("status", {
      enum: SUMMARY_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),

    nextRunAt: integer("next_run_at"),

    // Content
    title: text("title"),
    summaryText: text("summary_text"),
    highlights: text("highlights_json"),
    stats: text("stats_json"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idx_as_window").on(table.windowStart, table.windowEnd),
    index("idx_as_status").on(table.status),
  ]
);

/**
 * Activity Events table
 * Stores cross-window event sessions for Activity Monitor
 * - Events can span multiple 20-min windows
 * - isLong is computed from durationMs >= 30min (backend rule)
 */
export const activityEvents = sqliteTable(
  "activity_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Event identification (unique session key for idempotency)
    eventKey: text("event_key").notNull().unique(),

    // Event metadata
    title: text("title").notNull(),
    kind: text("kind").notNull(), // e.g. focus/work/meeting/break/browse/coding

    startTs: integer("start_ts").notNull(),
    endTs: integer("end_ts").notNull(),

    durationMs: integer("duration_ms").notNull().default(0),

    // Associations
    summaryId: integer("summary_id").references(() => activitySummaries.id),
    threadId: text("thread_id").references(() => threads.id),

    // Long event
    isLong: integer("is_long", { mode: "boolean" }).notNull().default(false),

    // Event details (on-demand LLM generation)
    detailsText: text("details_text"),
    detailsStatus: text("details_status", {
      enum: ACTIVITY_EVENT_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    detailsAttempts: integer("details_attempts").notNull().default(0),
    detailsNextRunAt: integer("details_next_run_at"),

    // Linked nodes
    nodeIds: text("node_ids_json"),

    confidence: integer("confidence"),
    importance: integer("importance"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_ae_summary").on(table.summaryId),
    index("idx_ae_thread").on(table.threadId),
    index("idx_ae_time").on(table.startTs, table.endTs),
  ]
);

/**
 * LLM Usage Events table
 * Records individual LLM invocations for tracking and auditing
 */
export const llmUsageEvents = sqliteTable(
  "llm_usage_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ts: integer("ts").notNull(), // timestamp in ms

    // Context
    capability: text("capability", { enum: LLM_USAGE_CAPABILITY_VALUES }).notNull(),
    operation: text("operation").notNull(), // e.g. vlm_analyze_shard, text_expand, text_merge, embedding_node

    // Status
    status: text("status", { enum: LLM_USAGE_STATUS_VALUES }).notNull(),
    errorCode: text("error_code"), // High-level error code/category, not full stack trace

    // Model & Config
    model: text("model").notNull(),
    provider: text("provider"), // e.g. openai_compatible
    configHash: text("config_hash").notNull(), // Hash of critical config params to detect backend changes

    // Usage Stats (allow null if provider doesn't support them)
    totalTokens: integer("total_tokens"),

    // Metadata about whether usage was actually returned
    usageStatus: text("usage_status", { enum: LLM_TOKEN_USAGE_STATUS_VALUES }).notNull(),
  },
  (table) => [
    index("idx_llm_usage_ts").on(table.ts),
    index("idx_llm_usage_model_ts").on(table.model, table.ts),
    index("idx_llm_usage_capability_ts").on(table.capability, table.ts),
  ]
);

/**
 * LLM Usage Daily Rollups table
 * pre-aggregated daily stats to speed up charts/reports
 */
export const llmUsageDailyRollups = sqliteTable(
  "llm_usage_daily_rollups",
  {
    day: text("day").notNull(), // YYYY-MM-DD
    model: text("model").notNull(),
    capability: text("capability").notNull(),

    // Counts
    requestCountSucceeded: integer("request_count_succeeded").notNull().default(0),
    requestCountFailed: integer("request_count_failed").notNull().default(0),

    // Tokens
    totalTokensSum: integer("total_tokens_sum").notNull().default(0),

    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    // Composite unique index for upserting
    uniqueIndex("idx_heatmap_unique").on(table.day, table.model, table.capability),
  ]
);

// ============================================================================
// Type Exports
// ============================================================================

// LLM Config types
export type LLMConfigRecord = typeof llmConfig.$inferSelect;
export type NewLLMConfigRecord = typeof llmConfig.$inferInsert;

// Screenshot types
export type ScreenshotRecord = typeof screenshots.$inferSelect;
export type NewScreenshotRecord = typeof screenshots.$inferInsert;

// Batch types
export type BatchRecord = typeof batches.$inferSelect;
export type NewBatchRecord = typeof batches.$inferInsert;

// Thread types
export type ThreadRecord = typeof threads.$inferSelect;
export type NewThreadRecord = typeof threads.$inferInsert;

// Context Node types
export type ContextNodeRecord = typeof contextNodes.$inferSelect;
export type NewContextNodeRecord = typeof contextNodes.$inferInsert;

// Context Screenshot Link types
export type ContextScreenshotLinkRecord = typeof contextScreenshotLinks.$inferSelect;
export type NewContextScreenshotLinkRecord = typeof contextScreenshotLinks.$inferInsert;

// Vector Document types
export type VectorDocumentRecord = typeof vectorDocuments.$inferSelect;
export type NewVectorDocumentRecord = typeof vectorDocuments.$inferInsert;

// Activity Summary types
export type ActivitySummaryRecord = typeof activitySummaries.$inferSelect;
export type NewActivitySummaryRecord = typeof activitySummaries.$inferInsert;

// Activity Event types
export type ActivityEventRecord = typeof activityEvents.$inferSelect;
export type NewActivityEventRecord = typeof activityEvents.$inferInsert;

// LLM Usage types
export type LLMUsageEventRecord = typeof llmUsageEvents.$inferSelect;
export type NewLLMUsageEventRecord = typeof llmUsageEvents.$inferInsert;

export type LLMUsageDailyRollupRecord = typeof llmUsageDailyRollups.$inferSelect;
export type NewLLMUsageDailyRollupRecord = typeof llmUsageDailyRollups.$inferInsert;

// ============================================================================
// Enum Type Exports (for use in other modules)
// ============================================================================
export type ProcessingStatus = (typeof PROCESSING_STATUS_VALUES)[number];
export type VlmStatus = (typeof VLM_STATUS_VALUES)[number];
export type OcrStatus = (typeof OCR_STATUS_VALUES)[number];
export type ThreadStatus = (typeof THREAD_STATUS_VALUES)[number];
export type EmbeddingStatus = (typeof EMBEDDING_STATUS_VALUES)[number];
export type IndexStatus = (typeof INDEX_STATUS_VALUES)[number];
export type SummaryStatus = (typeof SUMMARY_STATUS_VALUES)[number];
export type ActivityEventStatus = (typeof ACTIVITY_EVENT_STATUS_VALUES)[number];

export type LLMUsageCapability = (typeof LLM_USAGE_CAPABILITY_VALUES)[number];
export type LLMUsageStatus = (typeof LLM_USAGE_STATUS_VALUES)[number];
export type LLMTokenUsageStatus = (typeof LLM_TOKEN_USAGE_STATUS_VALUES)[number];
