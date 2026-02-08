-- Normalize FTS5 triggers to use FTS delete command syntax.
-- This fixes update/delete paths that can fail even when integrity-check passes.

DROP TRIGGER IF EXISTS screenshots_fts_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS screenshots_fts_update;--> statement-breakpoint
DROP TRIGGER IF EXISTS screenshots_fts_delete;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS screenshots_fts_insert AFTER INSERT ON screenshots
WHEN NEW.ocr_text IS NOT NULL
BEGIN
  INSERT INTO screenshots_fts(rowid, ocr_text) VALUES (NEW.id, NEW.ocr_text);
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS screenshots_fts_update AFTER UPDATE OF ocr_text ON screenshots
BEGIN
  INSERT INTO screenshots_fts(screenshots_fts, rowid, ocr_text)
  SELECT 'delete', OLD.id, OLD.ocr_text WHERE OLD.ocr_text IS NOT NULL;
  INSERT INTO screenshots_fts(rowid, ocr_text)
  SELECT NEW.id, NEW.ocr_text WHERE NEW.ocr_text IS NOT NULL;
END;--> statement-breakpoint

CREATE TRIGGER IF NOT EXISTS screenshots_fts_delete AFTER DELETE ON screenshots
BEGIN
  INSERT INTO screenshots_fts(screenshots_fts, rowid, ocr_text)
  SELECT 'delete', OLD.id, OLD.ocr_text WHERE OLD.ocr_text IS NOT NULL;
END;
