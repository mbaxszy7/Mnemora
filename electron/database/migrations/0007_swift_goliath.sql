DROP INDEX `idx_vector_documents_text_hash`;--> statement-breakpoint
CREATE INDEX `idx_vector_documents_text_hash` ON `vector_documents` (`text_hash`);