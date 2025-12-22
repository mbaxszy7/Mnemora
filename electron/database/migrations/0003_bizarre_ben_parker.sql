CREATE TABLE `activity_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`summary` text NOT NULL,
	`metadata` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_summaries_idempotency_key_unique` ON `activity_summaries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_activity_summaries_window` ON `activity_summaries` (`window_start`,`window_end`);--> statement-breakpoint
CREATE INDEX `idx_activity_summaries_status` ON `activity_summaries` (`status`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`source_key` text NOT NULL,
	`screenshot_ids` text NOT NULL,
	`ts_start` integer NOT NULL,
	`ts_end` integer NOT NULL,
	`history_pack` text,
	`idempotency_key` text NOT NULL,
	`shard_status_json` text,
	`index_json` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_batch_id_unique` ON `batches` (`batch_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `batches_idempotency_key_unique` ON `batches` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_batches_status` ON `batches` (`status`);--> statement-breakpoint
CREATE INDEX `idx_batches_source_key` ON `batches` (`source_key`);--> statement-breakpoint
CREATE TABLE `context_edges` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`from_node_id` integer NOT NULL,
	`to_node_id` integer NOT NULL,
	`edge_type` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`from_node_id`) REFERENCES `context_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_node_id`) REFERENCES `context_nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_context_edges_from` ON `context_edges` (`from_node_id`);--> statement-breakpoint
CREATE INDEX `idx_context_edges_to` ON `context_edges` (`to_node_id`);--> statement-breakpoint
CREATE INDEX `idx_context_edges_type` ON `context_edges` (`edge_type`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_edges_unique` ON `context_edges` (`from_node_id`,`to_node_id`,`edge_type`);--> statement-breakpoint
CREATE TABLE `context_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`thread_id` text,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`keywords` text,
	`entities` text,
	`importance` integer DEFAULT 5 NOT NULL,
	`confidence` integer DEFAULT 5 NOT NULL,
	`event_time` integer,
	`merged_from_ids` text,
	`payload_json` text,
	`merge_status` text DEFAULT 'pending' NOT NULL,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_context_nodes_kind` ON `context_nodes` (`kind`);--> statement-breakpoint
CREATE INDEX `idx_context_nodes_thread_id` ON `context_nodes` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_context_nodes_embedding_status` ON `context_nodes` (`embedding_status`);--> statement-breakpoint
CREATE TABLE `context_screenshot_links` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_id` integer NOT NULL,
	`screenshot_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`node_id`) REFERENCES `context_nodes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`screenshot_id`) REFERENCES `screenshots`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_csl_node` ON `context_screenshot_links` (`node_id`);--> statement-breakpoint
CREATE INDEX `idx_csl_screenshot` ON `context_screenshot_links` (`screenshot_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_csl_unique` ON `context_screenshot_links` (`node_id`,`screenshot_id`);--> statement-breakpoint
CREATE TABLE `entity_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` integer NOT NULL,
	`alias` text NOT NULL,
	`alias_type` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `context_nodes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_entity_aliases_entity` ON `entity_aliases` (`entity_id`);--> statement-breakpoint
CREATE INDEX `idx_entity_aliases_alias` ON `entity_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_key` text NOT NULL,
	`ts` integer NOT NULL,
	`file_path` text,
	`storage_state` text DEFAULT 'ephemeral' NOT NULL,
	`retention_expires_at` integer,
	`phash` text,
	`width` integer,
	`height` integer,
	`bytes` integer,
	`mime` text,
	`app_hint` text,
	`window_title` text,
	`ocr_text` text,
	`ui_text_snippets` text,
	`detected_entities` text,
	`vlm_index_fragment` text,
	`vlm_status` text DEFAULT 'pending' NOT NULL,
	`vlm_attempts` integer DEFAULT 0 NOT NULL,
	`vlm_next_run_at` integer,
	`vlm_error_code` text,
	`vlm_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_screenshots_source_key` ON `screenshots` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_screenshots_ts` ON `screenshots` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_screenshots_vlm_status` ON `screenshots` (`vlm_status`);--> statement-breakpoint
CREATE INDEX `idx_screenshots_storage_state` ON `screenshots` (`storage_state`);--> statement-breakpoint
CREATE TABLE `vector_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vector_id` text NOT NULL,
	`doc_type` text NOT NULL,
	`ref_id` integer NOT NULL,
	`text_hash` text NOT NULL,
	`embedding` blob,
	`meta_payload` text NOT NULL,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`index_status` text DEFAULT 'pending' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vector_documents_vector_id_unique` ON `vector_documents` (`vector_id`);--> statement-breakpoint
CREATE INDEX `idx_vector_documents_embedding_status` ON `vector_documents` (`embedding_status`);--> statement-breakpoint
CREATE INDEX `idx_vector_documents_index_status` ON `vector_documents` (`index_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vector_documents_text_hash` ON `vector_documents` (`text_hash`);