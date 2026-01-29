ALTER TABLE `user_setting` ADD `context_rules_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `context_rules_markdown` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_setting` ADD `context_rules_updated_at` integer;