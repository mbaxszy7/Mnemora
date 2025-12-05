import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Settings table for storing application configuration
 */
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  value: text("value"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// ============================================================================
// Type Exports
// ============================================================================

export type Settings = typeof settings.$inferSelect;
export type NewSettings = typeof settings.$inferInsert;
