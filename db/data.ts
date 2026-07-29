import { env } from "cloudflare:workers";

export type AppUser = { email: string; displayName: string };
export type Workspace = {
  id: string;
  owner_email: string;
  name: string;
  slug: string;
  feedback_mode: "never_ask" | "ask_once" | "ask_always" | "off";
  collect_event_summaries: number;
  retention_days: number;
  created_at: string;
  updated_at: string;
};

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

const text = (value: unknown, max = 500) =>
  typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";

const database = () => {
  if (!env.DB) throw new Error("Database unavailable");
  return env.DB;
};

export async function ensureSchema() {
  const db = database();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      feedback_mode TEXT NOT NULL DEFAULT 'never_ask',
      collect_event_summaries INTEGER NOT NULL DEFAULT 1,
      retention_days INTEGER NOT NULL DEFAULT 30,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      revoked_at TEXT
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      external_id TEXT,
      agent_name TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(workspace_id, external_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      summary TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
      worked INTEGER NOT NULL,
      summary TEXT NOT NULL,
      confidence REAL,
      would_use_again INTEGER,
      friction TEXT NOT NULL DEFAULT 'none',
      source TEXT NOT NULL DEFAULT 'agent',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS sessions_workspace_created_idx ON sessions(workspace_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS events_session_sequence_idx ON events(session_id, sequence)"),
    db.prepare("CREATE INDEX IF NOT EXISTS feedback_workspace_created_idx ON feedback(workspace_id, created_at DESC)"),
  ]);
}

function workspaceName(user: AppUser) {
  const base = user.displayName.includes("@") ? user.email.split("@")[0] : user.displayName;
  return `${text(base, 60) || "My"} workspace`;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "workspace";
}

export async function getOrCreateWorkspace(user: AppUser): Promise<Workspace> {
  await ensureSchema();
  const db = database();
  const existing = await db.prepare("SELECT * FROM workspaces WHERE owner_email = ?").bind(user.email).first<Workspace>();
  if (existing) return existing;

  const workspaceId = id("ws");
  const workspaceSlug = `${slug(user.email.split("@")[0])}-${workspaceId.slice(-6)}`;
  await db.prepare(`INSERT INTO workspaces
    (id, owner_email, name, slug, feedback_mode, collect_event_summaries, retention_days, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'never_ask', 1, 30, ?, ?)`)
    .bind(workspaceId, user.email, workspaceName(user), workspaceSlug, now(), now()).run();
  return (await db.prepare("SELECT * FROM workspaces WHERE id = ?").bind(workspaceId).first<Workspace>())!;
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createApiKey(workspaceId: string, labelValue: unknown) {
  await ensureSchema();
  const secret = `af_live_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const key = {
    id: id("key"),
    label: text(labelValue, 60) || "Production",
    prefix: secret.slice(0, 16),
    key_hash: await sha256(secret),
    created_at: now(),
  };
  await database().prepare(`INSERT INTO api_keys
    (id, workspace_id, label, prefix, key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(key.id, workspaceId, key.label, key.prefix, key.key_hash, key.created_at).run();
  return { id: key.id, label: key.label, prefix: key.prefix, createdAt: key.created_at, secret };
}

export async function authenticateApiKey(request: Request) {
  await ensureSchema();
  const authorization = request.headers.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : (request.headers.get("x-api-key") || "").trim();
  if (!token.startsWith("af_live_")) return null;
  const keyHash = await sha256(token);
  const row = await database().prepare(`SELECT w.*, k.id AS api_key_id
    FROM api_keys k JOIN workspaces w ON w.id = k.workspace_id
    WHERE k.key_hash = ? AND k.revoked_at IS NULL`).bind(keyHash).first<Workspace & { api_key_id: string }>();
  if (!row) return null;
  await database().prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now(), row.api_key_id).run();
  return row;
}

export async function updatePolicy(workspaceId: string, input: Record<string, unknown>) {
  if (!["never_ask", "ask_once", "ask_always", "off"].includes(String(input.feedbackMode))) {
    throw new Error("feedbackMode must be never_ask, ask_once, ask_always, or off");
  }
  const mode = input.feedbackMode;
  const summaries = input.collectEventSummaries === false ? 0 : 1;
  const retention = Math.min(365, Math.max(1, Number(input.retentionDays) || 30));
  await database().prepare(`UPDATE workspaces SET feedback_mode = ?, collect_event_summaries = ?, retention_days = ?, updated_at = ? WHERE id = ?`)
    .bind(mode, summaries, retention, now(), workspaceId).run();
  return database().prepare("SELECT * FROM workspaces WHERE id = ?").bind(workspaceId).first<Workspace>();
}

export async function createSession(workspace: Workspace, input: Record<string, unknown>) {
  const task = text(input.task, 500);
  if (!task) throw new Error("task is required");
  const agentName = text(input.agentName, 100) || "unknown-agent";
  const externalId = text(input.externalId, 160) || null;
  if (externalId) {
    const existing = await database().prepare("SELECT * FROM sessions WHERE workspace_id = ? AND external_id = ?")
      .bind(workspace.id, externalId).first();
    if (existing) return existing;
  }
  const session = { id: id("sess"), workspace_id: workspace.id, external_id: externalId, agent_name: agentName, task, started_at: now() };
  await database().prepare(`INSERT INTO sessions
    (id, workspace_id, external_id, agent_name, task, status, started_at, created_at)
    VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`)
    .bind(session.id, session.workspace_id, session.external_id, session.agent_name, session.task, session.started_at, session.started_at).run();
  return database().prepare("SELECT * FROM sessions WHERE id = ?").bind(session.id).first();
}

export async function appendEvent(workspace: Workspace, sessionId: string, input: Record<string, unknown>) {
  const session = await database().prepare("SELECT id FROM sessions WHERE id = ? AND workspace_id = ?")
    .bind(sessionId, workspace.id).first();
  if (!session) throw new Error("session not found");
  const eventType = text(input.type, 40) || "event";
  const name = text(input.name, 120) || eventType;
  const status = ["started", "succeeded", "failed", "info"].includes(String(input.status)) ? String(input.status) : "info";
  const duration = Number.isFinite(Number(input.durationMs)) ? Math.max(0, Math.round(Number(input.durationMs))) : null;
  const sequenceRow = await database().prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM events WHERE session_id = ?")
    .bind(sessionId).first<{ next_sequence: number }>();
  const event = {
    id: id("evt"), sequence: sequenceRow?.next_sequence || 1, event_type: eventType, name, status,
    duration_ms: duration,
    summary: workspace.collect_event_summaries ? text(input.summary, 500) || null : null,
    error_code: text(input.errorCode, 80) || null,
    created_at: now(),
  };
  await database().prepare(`INSERT INTO events
    (id, workspace_id, session_id, sequence, event_type, name, status, duration_ms, summary, error_code, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.id, workspace.id, sessionId, event.sequence, event.event_type, event.name, event.status, event.duration_ms, event.summary, event.error_code, event.created_at).run();
  return event;
}

export async function completeSession(workspace: Workspace, sessionId: string, input: Record<string, unknown>) {
  const session = await database().prepare("SELECT * FROM sessions WHERE id = ? AND workspace_id = ?")
    .bind(sessionId, workspace.id).first<{ id: string; status: string }>();
  if (!session) throw new Error("session not found");
  const hasWorked = typeof input.worked === "boolean";
  const summary = text(input.summary, 700);
  if (workspace.feedback_mode === "never_ask" && (!hasWorked || summary.length < 8)) {
    throw new Error("worked and a feedback summary are required while automatic feedback is enabled");
  }
  const completedAt = now();
  await database().prepare("UPDATE sessions SET status = 'completed', completed_at = ? WHERE id = ? AND workspace_id = ?")
    .bind(completedAt, sessionId, workspace.id).run();

  let storedFeedback = null;
  if (hasWorked && summary) {
    const confidenceValue = Number(input.confidence);
    const confidence = Number.isFinite(confidenceValue) ? Math.min(1, Math.max(0, confidenceValue)) : null;
    const wouldUseAgain = typeof input.wouldUseAgain === "boolean" ? Number(input.wouldUseAgain) : null;
    const friction = text(input.friction, 80) || "none";
    const feedbackId = id("fb");
    await database().prepare(`INSERT INTO feedback
      (id, workspace_id, session_id, worked, summary, confidence, would_use_again, friction, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?)
      ON CONFLICT(session_id) DO UPDATE SET worked = excluded.worked, summary = excluded.summary,
        confidence = excluded.confidence, would_use_again = excluded.would_use_again,
        friction = excluded.friction, source = excluded.source, created_at = excluded.created_at`)
      .bind(feedbackId, workspace.id, sessionId, Number(input.worked), summary, confidence, wouldUseAgain, friction, completedAt).run();
    storedFeedback = await database().prepare("SELECT * FROM feedback WHERE session_id = ?").bind(sessionId).first();
  }
  return { sessionId, status: "completed", completedAt, feedbackStored: Boolean(storedFeedback), feedback: storedFeedback };
}

export async function getDashboard(workspace: Workspace) {
  await ensureSchema();
  const db = database();
  const [keyRows, sessionRows, feedbackRows, eventRows] = await Promise.all([
    db.prepare("SELECT id, label, prefix, created_at, last_used_at, revoked_at FROM api_keys WHERE workspace_id = ? ORDER BY created_at DESC").bind(workspace.id).all(),
    db.prepare("SELECT * FROM sessions WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").bind(workspace.id).all(),
    db.prepare(`SELECT f.*, s.task, s.agent_name, s.started_at, s.completed_at
      FROM feedback f JOIN sessions s ON s.id = f.session_id
      WHERE f.workspace_id = ? ORDER BY f.created_at DESC LIMIT 100`).bind(workspace.id).all(),
    db.prepare("SELECT * FROM events WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 1000").bind(workspace.id).all(),
  ]);
  const sessionsList = sessionRows.results as Array<Record<string, unknown>>;
  const feedbackList = feedbackRows.results as Array<Record<string, unknown>>;
  const eventsList = eventRows.results as Array<Record<string, unknown>>;
  const completed = sessionsList.filter((session) => session.status === "completed").length;
  const worked = feedbackList.filter((item) => Number(item.worked) === 1).length;
  const eventNames = new Map<string, number>();
  const friction = new Map<string, number>();
  eventsList.forEach((event) => eventNames.set(String(event.name), (eventNames.get(String(event.name)) || 0) + 1));
  feedbackList.forEach((item) => friction.set(String(item.friction), (friction.get(String(item.friction)) || 0) + 1));
  return {
    workspace,
    apiKeys: keyRows.results,
    sessions: sessionsList,
    feedback: feedbackList,
    events: eventsList,
    insights: {
      sessions: sessionsList.length,
      completed,
      feedbackCount: feedbackList.length,
      feedbackRate: completed ? Math.round((feedbackList.length / completed) * 100) : 0,
      successRate: feedbackList.length ? Math.round((worked / feedbackList.length) * 100) : 0,
      topEvents: [...eventNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count })),
      friction: [...friction.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    },
  };
}

export async function cleanupExpired(workspace: Workspace) {
  const cutoff = new Date(Date.now() - workspace.retention_days * 86400000).toISOString();
  await database().prepare("DELETE FROM sessions WHERE workspace_id = ? AND created_at < ?").bind(workspace.id, cutoff).run();
}
