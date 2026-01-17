ALTER TABLE `threads` ADD `origin_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_threads_origin_key` ON `threads` (`origin_key`);