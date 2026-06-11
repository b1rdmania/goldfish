// Search + retrieval over the local transcript database.

export function searchTranscripts(db, query, { source = null, limit = 20 } = {}) {
  // FTS5: escape double quotes, wrap each term so punctuation doesn't break syntax.
  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");

  const rows = db
    .prepare(
      `SELECT
         c.id AS conversation_id,
         c.source,
         c.title,
         c.project,
         c.updated_at,
         m.role,
         snippet(messages_fts, 0, '>>>', '<<<', ' … ', 24) AS snippet,
         bm25(messages_fts) AS rank
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN conversations c ON c.id = m.conversation_id
       WHERE messages_fts MATCH ?
         AND (? IS NULL OR c.source = ?)
       ORDER BY rank
       LIMIT ?`
    )
    .all(ftsQuery, source, source, limit);
  return rows;
}

export function readConversation(db, conversationId, { maxChars = 60_000 } = {}) {
  const conv = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId);
  if (!conv) return null;
  const msgs = db
    .prepare(
      `SELECT role, content, created_at FROM messages
       WHERE conversation_id = ? ORDER BY idx`
    )
    .all(conversationId);

  let text = "";
  for (const m of msgs) {
    const block = `[${m.role}]\n${m.content}\n\n`;
    if (text.length + block.length > maxChars) {
      text += `\n[truncated: ${msgs.length} messages total]`;
      break;
    }
    text += block;
  }
  return { ...conv, transcript: text };
}

export function listRecent(db, { source = null, limit = 20 } = {}) {
  return db
    .prepare(
      `SELECT id, source, title, project, updated_at, message_count
       FROM conversations
       WHERE (? IS NULL OR source = ?)
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(source, source, limit);
}

export function stats(db) {
  return db
    .prepare(
      `SELECT source, COUNT(*) AS conversations, SUM(message_count) AS messages
       FROM conversations GROUP BY source`
    )
    .all();
}
