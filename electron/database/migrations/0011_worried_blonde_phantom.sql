CREATE TABLE `activity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_key` text NOT NULL,
	`start_ts` integer NOT NULL,
	`end_ts` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`title` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` integer DEFAULT 5 NOT NULL,
	`importance` integer DEFAULT 5 NOT NULL,
	`thread_id` text,
	`node_ids` text,
	`is_long` integer DEFAULT false NOT NULL,
	`details` text,
	`details_status` text DEFAULT 'pending' NOT NULL,
	`details_attempts` integer DEFAULT 0 NOT NULL,
	`details_next_run_at` integer,
	`details_error_code` text,
	`details_error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_events_event_key_unique` ON `activity_events` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_activity_events_time` ON `activity_events` (`start_ts`,`end_ts`);--> statement-breakpoint
CREATE INDEX `idx_activity_events_thread` ON `activity_events` (`thread_id`,`start_ts`);--> statement-breakpoint
CREATE INDEX `idx_activity_events_is_long` ON `activity_events` (`is_long`,`start_ts`);--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `title` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `highlights` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `stats` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `next_run_at` integer;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` ADD `error_message` text;--> statement-breakpoint
ALTER TABLE `activity_summaries` DROP COLUMN `metadata`;