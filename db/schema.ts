import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const cloudStates = sqliteTable("cloud_states", {
  userId: text("user_id").primaryKey(),
  email: text("email").notNull(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(1),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});
