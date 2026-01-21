DROP INDEX `idx_vd_text_hash`;--> statement-breakpoint
CREATE INDEX `idx_vd_text_hash` ON `vector_documents` (`text_hash`);