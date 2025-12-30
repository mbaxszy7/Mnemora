CREATE TABLE `llm_usage_daily_rollups` (
	`day` text NOT NULL,
	`model` text NOT NULL,
	`capability` text NOT NULL,
	`request_count_succeeded` integer DEFAULT 0 NOT NULL,
	`request_count_failed` integer DEFAULT 0 NOT NULL,
	`prompt_tokens_sum` integer DEFAULT 0 NOT NULL,
	`completion_tokens_sum` integer DEFAULT 0 NOT NULL,
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
	`prompt_tokens` integer,
	`completion_tokens` integer,
	`total_tokens` integer,
	`input_image_count` integer,
	`usage_status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_llm_usage_ts` ON `llm_usage_events` (`ts`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_model_ts` ON `llm_usage_events` (`model`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_llm_usage_capability_ts` ON `llm_usage_events` (`capability`,`ts`);