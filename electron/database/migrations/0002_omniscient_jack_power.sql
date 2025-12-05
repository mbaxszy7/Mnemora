ALTER TABLE `settings` RENAME TO `llm_config`;--> statement-breakpoint
DROP INDEX `settings_key_unique`;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `mode` text NOT NULL;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `unified_base_url` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `unified_api_key` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `unified_model` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `vlm_base_url` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `vlm_api_key` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `vlm_model` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `text_llm_base_url` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `text_llm_api_key` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `text_llm_model` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `embedding_base_url` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `embedding_api_key` text;--> statement-breakpoint
ALTER TABLE `llm_config` ADD `embedding_model` text;--> statement-breakpoint
ALTER TABLE `llm_config` DROP COLUMN `key`;--> statement-breakpoint
ALTER TABLE `llm_config` DROP COLUMN `value`;