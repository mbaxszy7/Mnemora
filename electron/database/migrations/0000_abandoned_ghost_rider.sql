CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`summary_id` integer,
	`thread_id` text,
	`is_long` integer DEFAULT false NOT NULL,
	`details_text` text,
	`details_status` text DEFAULT 'pending' NOT NULL,
	`details_attempts` integer DEFAULT 0 NOT NULL,
	`details_next_run_at` integer,
	`node_ids_json` text,
	`confidence` integer,
	`importance` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`summary_id`) REFERENCES `activity_summaries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_events_event_key_unique` ON `activity_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_ae_summary` ON `activity_events` (`summary_id`);--> statement-breakpoint
CREATE INDEX `idx_ae_thread` ON `activity_events` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_ae_time` ON `activity_events` (`start_ts`,`end_ts`);--> statement-breakpoint
CREATE TABLE `activity_summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`window_start` integer NOT NULL,
	`window_end` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer,
	`summary_text` text,
	`highlights_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_as_window` ON `activity_summaries` (`window_start`,`window_end`);--> statement-breakpoint
CREATE INDEX `idx_as_status` ON `activity_summaries` (`status`);--> statement-breakpoint
CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` text NOT NULL,
	`source_key` text NOT NULL,
	`ts_start` integer NOT NULL,
	`ts_end` integer NOT NULL,
	`vlm_status` text DEFAULT 'pending' NOT NULL,
	`vlm_attempts` integer DEFAULT 0 NOT NULL,
	`vlm_next_run_at` integer,
	`vlm_error_message` text,
	`thread_llm_status` text DEFAULT 'pending' NOT NULL,
	`thread_llm_attempts` integer DEFAULT 0 NOT NULL,
	`thread_llm_next_run_at` integer,
	`thread_llm_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `batches_batch_id_unique` ON `batches` (`batch_id`);--> statement-breakpoint
CREATE INDEX `idx_batches_vlm_status` ON `batches` (`vlm_status`);--> statement-breakpoint
CREATE INDEX `idx_batches_thread_llm_status` ON `batches` (`thread_llm_status`);--> statement-breakpoint
CREATE INDEX `idx_batches_source_key` ON `batches` (`source_key`);--> statement-breakpoint
CREATE TABLE `context_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`batch_id` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`event_time` integer NOT NULL,
	`thread_id` text,
	`thread_snapshot_json` text,
	`app_context_json` text NOT NULL,
	`knowledge_json` text,
	`state_snapshot_json` text,
	`ui_text_snippets_json` text,
	`importance` integer DEFAULT 5 NOT NULL,
	`confidence` integer DEFAULT 5 NOT NULL,
	`keywords_json` text DEFAULT '[]' NOT NULL,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`embedding_attempts` integer DEFAULT 0 NOT NULL,
	`embedding_next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_context_nodes_thread_id` ON `context_nodes` (`thread_id`);--> statement-breakpoint
CREATE INDEX `idx_context_nodes_event_time` ON `context_nodes` (`event_time`);--> statement-breakpoint
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
CREATE TABLE `llm_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`mode` text NOT NULL,
	`unified_base_url` text,
	`unified_api_key` text,
	`unified_model` text,
	`vlm_base_url` text,
	`vlm_api_key` text,
	`vlm_model` text,
	`text_llm_base_url` text,
	`text_llm_api_key` text,
	`text_llm_model` text,
	`embedding_base_url` text,
	`embedding_api_key` text,
	`embedding_model` text,
	`language` text DEFAULT 'en' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `llm_usage_daily_rollups` (
	`day` text NOT NULL,
	`model` text NOT NULL,
	`capability` text NOT NULL,
	`request_count_succeeded` integer DEFAULT 0 NOT NULL,
	`request_count_failed` integer DEFAULT 0 NOT NULL,
	`total_tokens_sum` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_heatmap_unique` ON `llm_usage_daily_rollups` (`day`,`model`,`capability`);--> statement-breakpoint
CREATE TABLE `llm_usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`capability` text NOT NULL,
	`operation` text NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`model` text NOT NULL,
	`provider` text,
	`config_hash` text NOT NULL,
	`total_tokens` integer,
	`usage_status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_llm_usage_ts` ON `llm_usage_events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_model_ts` ON `llm_usage_events` (`model`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_capability_ts` ON `llm_usage_events` (`capability`,`ts`);--> statement-breakpoint
CREATE TABLE `screenshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_key` text NOT NULL,
	`ts` integer NOT NULL,
	`phash` text NOT NULL,
	`width` integer,
	`height` integer,
	`app_hint` text,
	`window_title` text,
	`ocr_text` text,
	`ocr_status` text,
	`batch_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_screenshots_source_key` ON `screenshots` (`source_key`);--> statement-breakpoint
CREATE INDEX `idx_screenshots_ts` ON `screenshots` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_screenshots_batch_id` ON `screenshots` (`batch_id`);--> statement-breakpoint
CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`current_phase` text,
	`current_focus` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_time` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`node_count` integer DEFAULT 0 NOT NULL,
	`apps_json` text DEFAULT '[]' NOT NULL,
	`main_project` text,
	`key_entities_json` text DEFAULT '[]' NOT NULL,
	`milestones_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_threads_last_active_at` ON `threads` (`last_active_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_status` ON `threads` (`status`);--> statement-breakpoint
CREATE TABLE `vector_documents` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`vector_id` text NOT NULL,
	`doc_type` text NOT NULL,
	`ref_id` integer NOT NULL,
	`text_content` text NOT NULL,
	`text_hash` text NOT NULL,
	`meta_payload_json` text,
	`embedding` blob,
	`embedding_status` text DEFAULT 'pending' NOT NULL,
	`embedding_attempts` integer DEFAULT 0 NOT NULL,
	`embedding_next_run_at` integer,
	`index_status` text DEFAULT 'pending' NOT NULL,
	`index_attempts` integer DEFAULT 0 NOT NULL,
	`index_next_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vector_documents_vector_id_unique` ON `vector_documents` (`vector_id`);--> statement-breakpoint
CREATE INDEX `idx_vd_embedding_status` ON `vector_documents` (`embedding_status`);--> statement-breakpoint
CREATE INDEX `idx_vd_index_status` ON `vector_documents` (`index_status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vd_text_hash` ON `vector_documents` (`text_hash`);