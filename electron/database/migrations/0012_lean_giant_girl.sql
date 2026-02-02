ALTER TABLE `user_setting` ADD `notification_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_activity_summary` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_llm_errors` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_capture_paused` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_sound_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_do_not_disturb` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_do_not_disturb_from` text DEFAULT '22:00' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `notification_do_not_disturb_to` text DEFAULT '08:00' NOT NULL;