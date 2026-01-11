import {
  sqliteTable,
  text,
  integer,
  blob,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const STORAGE_STATE_VALUES = ["ephemeral", "persisted", "deleted"] as const;
export const VLM_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;
export const BATCH_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;
export const CONTEXT_KIND_VALUES = [
  "event",
  "knowledge",
  "state_snapshot",
  "procedure",
  "plan",
  "entity_profile",
] as const;
// Note: Screenshot evidence is tracked via context_screenshot_links table, not edges
export const EDGE_TYPE_VALUES = [
  "event_next",
  "event_mentions_entity",
  "event_produces_knowledge",
  "event_updates_state",
  "event_suggests_plan",
  "event_uses_procedure",
] as const;
export const MERGE_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;
export const EMBEDDING_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;
export const INDEX_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;
export const ALIAS_TYPE_VALUES = ["nickname", "abbr", "translation"] as const;
export const ALIAS_SOURCE_VALUES = ["ocr", "vlm", "llm", "manual"] as const;
export const DOC_TYPE_VALUES = ["context_node", "screenshot_snippet"] as const;
export const SUMMARY_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
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

/**
 * Batches table
 * Stores batch processing jobs for VLM analysis
 */
export const batches = sqliteTable(
  "batches",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Batch identification
    batchId: text("batch_id").notNull().unique(),
    sourceKey: text("source_key").notNull(),

    // Batch content
    screenshotIds: text("screenshot_ids").notNull(), // JSON array of screenshot IDs
    tsStart: integer("ts_start").notNull(),
    tsEnd: integer("ts_end").notNull(),
    historyPack: text("history_pack"), // JSON: HistoryPack object

    // Idempotency
    idempotencyKey: text("idempotency_key").notNull().unique(),

    // Processing state
    shardStatusJson: text("shard_status_json"), // JSON: {shard0: {status, attempts, error}, ...}
    indexJson: text("index_json"), // JSON: merged VLM Index result

    // Status tracking
    status: text("status", {
      enum: BATCH_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: integer("next_run_at"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_batches_status").on(table.status),
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

    // File storage
    filePath: text("file_path"),
    storageState: text("storage_state", {
      enum: STORAGE_STATE_VALUES,
    })
      .notNull()
      .default("ephemeral"),
    retentionExpiresAt: integer("retention_expires_at"),

    // Image metadata
    phash: text("phash"), // perceptual hash for deduplication
    width: integer("width"),
    height: integer("height"),
    bytes: integer("bytes"),
    mime: text("mime"),

    // Evidence pack fields
    appHint: text("app_hint"),
    windowTitle: text("window_title"),
    ocrText: text("ocr_text"), // limited to 8k characters
    uiTextSnippets: text("ui_text_snippets"), // JSON array of high-value text snippets
    detectedEntities: text("detected_entities"), // JSON array of detected entities
    vlmIndexFragment: text("vlm_index_fragment"), // JSON fragment from VLM output

    // VLM processing status
    vlmStatus: text("vlm_status", {
      enum: VLM_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    vlmAttempts: integer("vlm_attempts").notNull().default(0),
    vlmNextRunAt: integer("vlm_next_run_at"),
    vlmErrorCode: text("vlm_error_code"),
    vlmErrorMessage: text("vlm_error_message"),
    enqueuedBatchId: integer("enqueued_batch_id").references(() => batches.id),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_screenshots_source_key").on(table.sourceKey),
    index("idx_screenshots_ts").on(table.ts),
    index("idx_screenshots_vlm_status").on(table.vlmStatus),
    index("idx_screenshots_storage_state").on(table.storageState),
    index("idx_screenshots_enqueued_batch_id").on(table.enqueuedBatchId),
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

    // Node type and identity
    kind: text("kind", {
      enum: CONTEXT_KIND_VALUES,
    }).notNull(),
    threadId: text("thread_id"), // groups related events into threads
    originKey: text("origin_key"),

    // Content
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    keywords: text("keywords"), // JSON array of keywords
    entities: text("entities"), // JSON array of EntityRef objects

    // Scoring
    importance: integer("importance").notNull().default(5), // 0-10 scale
    confidence: integer("confidence").notNull().default(5), // 0-10 scale

    // Timing
    eventTime: integer("event_time"), // when the event occurred

    // Merge tracking
    mergedFromIds: text("merged_from_ids"), // JSON array of merged node IDs

    // Additional data
    payloadJson: text("payload_json"), // type-specific additional data

    // Processing status
    mergeStatus: text("merge_status", {
      enum: MERGE_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    mergeAttempts: integer("merge_attempts").notNull().default(0),
    mergeNextRunAt: integer("merge_next_run_at"),
    mergeErrorCode: text("merge_error_code"),
    mergeErrorMessage: text("merge_error_message"),
    embeddingStatus: text("embedding_status", {
      enum: EMBEDDING_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    embeddingAttempts: integer("embedding_attempts").notNull().default(0),
    embeddingNextRunAt: integer("embedding_next_run_at"),
    embeddingErrorCode: text("embedding_error_code"),
    embeddingErrorMessage: text("embedding_error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_context_nodes_kind").on(table.kind),
    index("idx_context_nodes_thread_id").on(table.threadId),
    index("idx_context_nodes_merge_status").on(table.mergeStatus),
    index("idx_context_nodes_embedding_status").on(table.embeddingStatus),
    uniqueIndex("idx_context_nodes_origin_key_unique").on(table.originKey),
  ]
);

/**
 * Context Edges table
 * Stores relationships between context nodes
 */
export const contextEdges = sqliteTable(
  "context_edges",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Edge endpoints
    fromNodeId: integer("from_node_id")
      .notNull()
      .references(() => contextNodes.id),
    toNodeId: integer("to_node_id")
      .notNull()
      .references(() => contextNodes.id),

    // Edge type
    edgeType: text("edge_type", {
      enum: EDGE_TYPE_VALUES,
    }).notNull(),

    // Timestamps
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_context_edges_from").on(table.fromNodeId),
    index("idx_context_edges_to").on(table.toNodeId),
    index("idx_context_edges_type").on(table.edgeType),
    uniqueIndex("idx_context_edges_unique").on(table.fromNodeId, table.toNodeId, table.edgeType),
  ]
);

/**
 * Context Screenshot Links table
 * Links context nodes to their source screenshots
 */
export const contextScreenshotLinks = sqliteTable(
  "context_screenshot_links",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Link endpoints
    nodeId: integer("node_id")
      .notNull()
      .references(() => contextNodes.id),
    screenshotId: integer("screenshot_id")
      .notNull()
      .references(() => screenshots.id),

    // Timestamps
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_csl_node").on(table.nodeId),
    index("idx_csl_screenshot").on(table.screenshotId),
    uniqueIndex("idx_csl_unique").on(table.nodeId, table.screenshotId),
  ]
);

/**
 * Entity Aliases table
 * Stores alternative names/aliases for entity profiles
 */
export const entityAliases = sqliteTable(
  "entity_aliases",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),

    // Entity reference
    entityId: integer("entity_id")
      .notNull()
      .references(() => contextNodes.id),

    // Alias information
    alias: text("alias").notNull(),
    aliasType: text("alias_type", {
      enum: ALIAS_TYPE_VALUES,
    }),
    confidence: real("confidence").notNull().default(1.0),
    source: text("source", {
      enum: ALIAS_SOURCE_VALUES,
    }),

    // Timestamps
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("idx_entity_aliases_entity").on(table.entityId),
    index("idx_entity_aliases_alias").on(table.alias),
    uniqueIndex("idx_entity_aliases_entity_alias_unique").on(table.entityId, table.alias),
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
    docType: text("doc_type", {
      enum: DOC_TYPE_VALUES,
    }).notNull(),
    refId: integer("ref_id").notNull(), // references context_nodes.id or screenshots.id

    // Content hash for idempotency
    textHash: text("text_hash").notNull(),

    // Embedding data
    embedding: blob("embedding"), // stored as BLOB for index rebuild capability

    // Metadata for filtering
    metaPayload: text("meta_payload").notNull(), // JSON: {kind, thread_id, ts, app_hint, entities, source_key}

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
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_vector_documents_embedding_status").on(table.embeddingStatus),
    index("idx_vector_documents_index_status").on(table.indexStatus),
    index("idx_vector_documents_text_hash").on(table.textHash),
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

    // Idempotency
    idempotencyKey: text("idempotency_key").notNull().unique(),

    // Summary content (extended for Milestone 6)
    title: text("title"), // One-line title for timeline block display
    summary: text("summary").notNull(), // Markdown content
    highlights: text("highlights"), // JSON: string[] - key highlights
    stats: text("stats"), // JSON: { topApps[], topEntities[], nodeCount, screenshotCount, threadCount }

    // Processing status
    status: text("status", {
      enum: SUMMARY_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextRunAt: integer("next_run_at"), // For retry scheduling
    errorCode: text("error_code"),
    errorMessage: text("error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_activity_summaries_window").on(table.windowStart, table.windowEnd),
    index("idx_activity_summaries_status").on(table.status),
  ]
);

export const ACTIVITY_EVENT_STATUS_VALUES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "failed_permanent",
] as const;

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

    // Time range
    startTs: integer("start_ts").notNull(),
    endTs: integer("end_ts").notNull(),
    durationMs: integer("duration_ms").notNull(), // Computed: endTs - startTs

    // Event metadata
    title: text("title").notNull(),
    kind: text("kind").notNull(), // e.g. focus/work/meeting/break/browse/coding
    confidence: integer("confidence").notNull().default(5), // 0-10
    importance: integer("importance").notNull().default(5), // 0-10

    // Associations
    threadId: text("thread_id"), // From context_nodes.threadId for cross-window aggregation
    nodeIds: text("node_ids"), // JSON: number[] - associated context_nodes.id

    // Long event marker (computed from durationMs >= 30min)
    isLong: integer("is_long", { mode: "boolean" }).notNull().default(false),

    // Event details (on-demand LLM generation)
    details: text("details"), // Markdown content
    detailsStatus: text("details_status", {
      enum: ACTIVITY_EVENT_STATUS_VALUES,
    })
      .notNull()
      .default("pending"),
    detailsAttempts: integer("details_attempts").notNull().default(0),
    detailsNextRunAt: integer("details_next_run_at"),
    detailsErrorCode: text("details_error_code"),
    detailsErrorMessage: text("details_error_message"),

    // Timestamps
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("idx_activity_events_time").on(table.startTs, table.endTs),
    index("idx_activity_events_thread").on(table.threadId, table.startTs),
    index("idx_activity_events_is_long").on(table.isLong, table.startTs),
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

// Context Node types
export type ContextNodeRecord = typeof contextNodes.$inferSelect;
export type NewContextNodeRecord = typeof contextNodes.$inferInsert;

// Context Edge types
export type ContextEdgeRecord = typeof contextEdges.$inferSelect;
export type NewContextEdgeRecord = typeof contextEdges.$inferInsert;

// Context Screenshot Link types
export type ContextScreenshotLinkRecord = typeof contextScreenshotLinks.$inferSelect;
export type NewContextScreenshotLinkRecord = typeof contextScreenshotLinks.$inferInsert;

// Entity Alias types
export type EntityAliasRecord = typeof entityAliases.$inferSelect;
export type NewEntityAliasRecord = typeof entityAliases.$inferInsert;

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

export type StorageState = (typeof STORAGE_STATE_VALUES)[number];
export type VlmStatus = (typeof VLM_STATUS_VALUES)[number];
export type BatchStatus = (typeof BATCH_STATUS_VALUES)[number];
export type ContextKind = (typeof CONTEXT_KIND_VALUES)[number];
export type EdgeType = (typeof EDGE_TYPE_VALUES)[number];
export type MergeStatus = (typeof MERGE_STATUS_VALUES)[number];
export type EmbeddingStatus = (typeof EMBEDDING_STATUS_VALUES)[number];
export type IndexStatus = (typeof INDEX_STATUS_VALUES)[number];
export type AliasType = (typeof ALIAS_TYPE_VALUES)[number];
export type AliasSource = (typeof ALIAS_SOURCE_VALUES)[number];
export type DocType = (typeof DOC_TYPE_VALUES)[number];
export type SummaryStatus = (typeof SUMMARY_STATUS_VALUES)[number];
export type ActivityEventStatus = (typeof ACTIVITY_EVENT_STATUS_VALUES)[number];

export type LLMUsageCapability = (typeof LLM_USAGE_CAPABILITY_VALUES)[number];
export type LLMUsageStatus = (typeof LLM_USAGE_STATUS_VALUES)[number];
export type LLMTokenUsageStatus = (typeof LLM_TOKEN_USAGE_STATUS_VALUES)[number];
