ALTER TABLE `user_setting` ADD `onboarding_progress` text DEFAULT 'pending_home' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `onboarding_updated_at` integer;