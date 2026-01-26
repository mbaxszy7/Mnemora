CREATE TABLE `user_setting` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`capture_primary_screen_only` integer DEFAULT true NOT NULL,
	`capture_schedule_enabled` integer DEFAULT true NOT NULL,
	`capture_allowed_windows_json` text DEFAULT '[{"start":"10:00","end":"12:00"},{"start":"14:00","end":"18:00"}]' NOT NULL,
	`capture_manual_override` text DEFAULT 'none' NOT NULL,
	`capture_manual_override_updated_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
