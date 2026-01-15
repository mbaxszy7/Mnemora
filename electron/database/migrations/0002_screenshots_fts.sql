-- FTS5 Virtual Table for OCR Text Search
-- This migration creates an FTS5 virtual table for full-text search on OCR text.
-- External Content mode is used to sync with screenshots.ocr_text via triggers.

-- Create FTS5 virtual table for OCR text search
CREATE VIRTUAL TABLE IF NOT EXISTS screenshots_fts USING fts5(
  ocr_text,
  content='screenshots',
  content_rowid='id'
);

-- Trigger: INSERT - Add to FTS when ocr_text is inserted
CREATE TRIGGER IF NOT EXISTS screenshots_fts_insert AFTER INSERT ON screenshots
WHEN NEW.ocr_text IS NOT NULL
BEGIN
  INSERT INTO screenshots_fts(rowid, ocr_text) VALUES (NEW.id, NEW.ocr_text);
END;

-- Trigger: UPDATE - Sync FTS when ocr_text is updated
CREATE TRIGGER IF NOT EXISTS screenshots_fts_update AFTER UPDATE OF ocr_text ON screenshots
BEGIN
  DELETE FROM screenshots_fts WHERE rowid = OLD.id;
  INSERT INTO screenshots_fts(rowid, ocr_text) 
  SELECT NEW.id, NEW.ocr_text WHERE NEW.ocr_text IS NOT NULL;
END;

-- Trigger: DELETE - Remove from FTS when screenshot is deleted
CREATE TRIGGER IF NOT EXISTS screenshots_fts_delete AFTER DELETE ON screenshots
BEGIN
  DELETE FROM screenshots_fts WHERE rowid = OLD.id;
END;
