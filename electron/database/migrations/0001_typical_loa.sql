ALTER TABLE `screenshots` ADD `ocr_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `screenshots` ADD `ocr_next_run_at` integer;--> statement-breakpoint
CREATE INDEX `idx_screenshots_ocr_status` ON `screenshots` (`ocr_status`);