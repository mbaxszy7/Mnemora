ALTER TABLE `activity_events` ADD `duration_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_ae_details_status` ON `activity_events` (`details_status`);--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `title` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `stats_json` text;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `entities_json` text DEFAULT '[]' NOT NULL;