import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
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
  return db;
}

export function upsertConversation(db, conv) {
  db.prepare(
    `INSERT INTO conversations (id, source, title, project, created_at, updated_at, message_count, raw_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, updated_at=excluded.updated_at,
       message_count=excluded.message_count, raw_path=excluded.raw_path`
  ).run(
    conv.id, conv.source, conv.title, conv.project,
    conv.created_at, conv.updated_at, conv.message_count, conv.raw_path
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
    messages.forEach((m, i) =>
      ins.run(conversationId, i, m.role, m.content, m.created_at ?? null)
    );
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
