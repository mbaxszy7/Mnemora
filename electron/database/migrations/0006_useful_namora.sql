ALTER TABLE `screenshots` ADD `enqueued_batch_id` integer REFERENCES batches(id);--> statement-breakpoint
CREATE INDEX `idx_screenshots_enqueued_batch_id` ON `screenshots` (`enqueued_batch_id`);