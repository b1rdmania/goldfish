// Search + retrieval over the local transcript database.
//
// All functions accept a `scope` — { sources: [...], projects: [...] } — which
// hard-limits what the caller can see. The MCP server sets it from
// --source/--project flags (or GOLDFISH_SOURCES/GOLDFISH_PROJECTS) so an agent
// can be given, say, only claude-code transcripts for one project.
// Sources match exactly; projects match as substrings (project values are
// full directory paths).

function scopeFilter(scope = {}) {
  const clauses = [];
  const params = [];
  if (scope.sources?.length) {
    clauses.push(`c.source IN (${scope.sources.map(() => "?").join(",")})`);
    params.push(...scope.sources);
  }
  if (scope.projects?.length) {
    clauses.push(
      `(${scope.projects.map(() => "c.project LIKE '%' || ? || '%'").join(" OR ")})`
    );
    params.push(...scope.projects);
  }
  return { clause: clauses.map((c) => ` AND ${c}`).join(""), params };
}

export function inScope(conv, scope = {}) {
  if (scope.sources?.length && !scope.sources.includes(conv.source)) return false;
  if (scope.projects?.length) {
    if (!conv.project) return false;
    if (!scope.projects.some((p) => conv.project.includes(p))) return false;
  }
  return true;
}

export function searchTranscripts(db, query, { source = null, limit = 20, scope = {} } = {}) {
  // FTS5: escape double quotes, wrap each term so punctuation doesn't break syntax.
  const ftsQuery = query
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");

  const sf = scopeFilter(scope);
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
         AND (? IS NULL OR c.source = ?)${sf.clause}
       ORDER BY rank
       LIMIT ?`
    )
    .all(ftsQuery, source, source, ...sf.params, limit);
  return rows;
}

export function readConversation(db, conversationId, { maxChars = 60_000, scope = {} } = {}) {
  const conv = db
    .prepare(`SELECT * FROM conversations WHERE id = ?`)
    .get(conversationId);
  // Out-of-scope reads as not-found: don't reveal that the conversation exists.
  if (!conv || !inScope(conv, scope)) return null;
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

export function listRecent(db, { source = null, limit = 20, scope = {} } = {}) {
  const sf = scopeFilter(scope);
  return db
    .prepare(
      `SELECT id, source, title, project, updated_at, message_count
       FROM conversations c
       WHERE (? IS NULL OR source = ?)${sf.clause}
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .all(source, source, ...sf.params, limit);
}

export function stats(db, { scope = {} } = {}) {
  const sf = scopeFilter(scope);
  return db
    .prepare(
      `SELECT source, COUNT(*) AS conversations, SUM(message_count) AS messages
       FROM conversations c
       WHERE 1=1${sf.clause}
       GROUP BY source`
    )
    .all(...sf.params);
}
