PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`origin_key` text NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`current_phase` text,
	`current_focus` text,
	`status` text DEFAULT 'active' NOT NULL,
	`start_time` integer NOT NULL,
	`last_active_at` integer NOT NULL,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`node_count` integer DEFAULT 0 NOT NULL,
	`apps_json` text DEFAULT '[]' NOT NULL,
	`main_project` text,
	`key_entities_json` text DEFAULT '[]' NOT NULL,
	`milestones_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_threads`("id", "origin_key", "title", "summary", "current_phase", "current_focus", "status", "start_time", "last_active_at", "duration_ms", "node_count", "apps_json", "main_project", "key_entities_json", "milestones_json", "created_at", "updated_at") SELECT "id", "origin_key", "title", "summary", "current_phase", "current_focus", "status", "start_time", "last_active_at", "duration_ms", "node_count", "apps_json", "main_project", "key_entities_json", "milestones_json", "created_at", "updated_at" FROM `threads`;--> statement-breakpoint
DROP TABLE `threads`;--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_threads_last_active_at` ON `threads` (`last_active_at`);--> statement-breakpoint
CREATE INDEX `idx_threads_status` ON `threads` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_threads_origin_key` ON `threads` (`origin_key`);