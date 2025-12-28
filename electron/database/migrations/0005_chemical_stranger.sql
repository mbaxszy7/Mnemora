ALTER TABLE `context_nodes` ADD `merge_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `merge_next_run_at` integer;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `merge_error_code` text;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `merge_error_message` text;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `embedding_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `embedding_next_run_at` integer;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `embedding_error_code` text;--> statement-breakpoint
ALTER TABLE `context_nodes` ADD `embedding_error_message` text;--> statement-breakpoint
ALTER TABLE `vector_documents` ADD `embedding_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vector_documents` ADD `embedding_next_run_at` integer;--> statement-breakpoint
ALTER TABLE `vector_documents` ADD `index_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vector_documents` ADD `index_next_run_at` integer;