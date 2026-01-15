ALTER TABLE `batches` ADD `screenshot_ids` text NOT NULL;--> statement-breakpoint
ALTER TABLE `screenshots` ADD `file_path` text;--> statement-breakpoint
ALTER TABLE `screenshots` ADD `storage_state` text;--> statement-breakpoint
CREATE INDEX `idx_context_nodes_batch_id` ON `context_nodes` (`batch_id`);