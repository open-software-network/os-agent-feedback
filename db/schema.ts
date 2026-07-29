import { sql } from "drizzle-orm";
import { integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  ownerEmail: text("owner_email").notNull().unique(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  feedbackMode: text("feedback_mode").notNull().default("never_ask"),
  collectEventSummaries: integer("collect_event_summaries").notNull().default(1),
  retentionDays: integer("retention_days").notNull().default(30),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  prefix: text("prefix").notNull(),
  keyHash: text("key_hash").notNull().unique(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  lastUsedAt: text("last_used_at"),
  revokedAt: text("revoked_at"),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  externalId: text("external_id"),
  agentName: text("agent_name").notNull(),
  task: text("task").notNull(),
  status: text("status").notNull().default("running"),
  startedAt: text("started_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  uniqueIndex("sessions_workspace_external_unique").on(table.workspaceId, table.externalId),
]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  eventType: text("event_type").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull(),
  durationMs: integer("duration_ms"),
  summary: text("summary"),
  errorCode: text("error_code"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const feedback = sqliteTable("feedback", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull().unique().references(() => sessions.id, { onDelete: "cascade" }),
  worked: integer("worked", { mode: "boolean" }).notNull(),
  summary: text("summary").notNull(),
  confidence: real("confidence"),
  wouldUseAgain: integer("would_use_again", { mode: "boolean" }),
  friction: text("friction").notNull().default("none"),
  source: text("source").notNull().default("agent"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
