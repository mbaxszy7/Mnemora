ALTER TABLE `llm_usage_daily_rollups` DROP COLUMN `prompt_tokens_sum`;--> statement-breakpoint
ALTER TABLE `llm_usage_daily_rollups` DROP COLUMN `completion_tokens_sum`;--> statement-breakpoint
ALTER TABLE `llm_usage_events` DROP COLUMN `prompt_tokens`;--> statement-breakpoint
ALTER TABLE `llm_usage_events` DROP COLUMN `completion_tokens`;--> statement-breakpoint
ALTER TABLE `llm_usage_events` DROP COLUMN `input_image_count`;