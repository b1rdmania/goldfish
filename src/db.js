import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { redactSecrets } from "./redact.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DB_PATH =
  process.env.GOLDFISH_DB || join(homedir(), ".goldfish", "goldfish.db");

export function openDb() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(readFileSync(join(__dirname, "schema.sql"), "utf8"));
  // Migration for databases created before the repo column existed.
  try {
    db.exec("ALTER TABLE conversations ADD COLUMN repo TEXT");
  } catch {
    /* column already exists */
  }
  return db;
}

export function upsertConversation(db, conv) {
  db.prepare(
    `INSERT INTO conversations (id, source, title, project, created_at, updated_at, message_count, raw_path, repo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, project=excluded.project, updated_at=excluded.updated_at,
       message_count=excluded.message_count, raw_path=excluded.raw_path,
       repo=excluded.repo`
  ).run(
    conv.id, conv.source, conv.title, conv.project,
    conv.created_at, conv.updated_at, conv.message_count, conv.raw_path,
    conv.repo ?? null
  );
}

export function replaceMessages(db, conversationId, messages) {
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(conversationId);
    const ins = db.prepare(
      `INSERT INTO messages (conversation_id, idx, role, content, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    // All ingest paths store through here, so redaction cannot be bypassed by
    // a parser forgetting to call it. See src/redact.js.
    messages.forEach((m, i) =>
      ins.run(conversationId, i, m.role, redactSecrets(m.content), m.created_at ?? null)
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Explicit cascade — SQLite foreign keys are off by default, and the FTS
// delete trigger fires on the messages delete either way.
export function deleteConversations(db, ids) {
  const delEmb = db.prepare(
    `DELETE FROM embeddings WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`
  );
  const delMsgs = db.prepare(`DELETE FROM messages WHERE conversation_id = ?`);
  const delConv = db.prepare(`DELETE FROM conversations WHERE id = ?`);
  db.exec("BEGIN");
  try {
    for (const id of ids) {
      delEmb.run(id);
      delMsgs.run(id);
      delConv.run(id);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return ids.length;
}

export function logAccess(db, { client, tool, args, resultCount, scope }) {
  db.prepare(
    `INSERT INTO access_log (ts, client, tool, args, result_count, scope)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    client ?? null,
    tool,
    JSON.stringify(args ?? {}),
    resultCount ?? null,
    scope ?? null
  );
}

export function readAccessLog(db, { limit = 50 } = {}) {
  return db
    .prepare(`SELECT ts, client, tool, args, result_count, scope
              FROM access_log ORDER BY id DESC LIMIT ?`)
    .all(limit);
}
