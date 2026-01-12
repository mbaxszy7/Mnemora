ALTER TABLE `context_nodes` ADD `origin_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_context_nodes_origin_key_unique` ON `context_nodes` (`origin_key`);