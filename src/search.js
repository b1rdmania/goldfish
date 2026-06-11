// Search + retrieval over the local transcript database.
//
// All functions accept a `scope` — { sources, projects, repos, since } — which
// hard-limits what the caller can see. The MCP server sets it from
// --source/--project/--repo/--since flags (or GOLDFISH_* env vars) so an agent
// can be given, say, only claude-code transcripts for one repo from the last
// 30 days. Sources match exactly; projects and repos match as substrings;
// since is an ISO 8601 cutoff on updated_at.

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
  if (scope.repos?.length) {
    clauses.push(
      `(${scope.repos.map(() => "c.repo LIKE '%' || ? || '%'").join(" OR ")})`
    );
    params.push(...scope.repos);
  }
  if (scope.since) {
    clauses.push(`c.updated_at >= ?`);
    params.push(scope.since);
  }
  return { clause: clauses.map((c) => ` AND ${c}`).join(""), params };
}

export function inScope(conv, scope = {}) {
  if (scope.sources?.length && !scope.sources.includes(conv.source)) return false;
  if (scope.projects?.length) {
    if (!conv.project) return false;
    if (!scope.projects.some((p) => conv.project.includes(p))) return false;
  }
  if (scope.repos?.length) {
    if (!conv.repo) return false;
    if (!scope.repos.some((r) => conv.repo.includes(r))) return false;
  }
  if (scope.since && (!conv.updated_at || conv.updated_at < scope.since)) return false;
  return true;
}

// "30d" / "12h" / "8w" → ISO cutoff from now; anything else is taken as an
// ISO date already. Returns null for empty input.
export function sinceToIso(spec) {
  if (!spec) return null;
  const m = String(spec).trim().match(/^(\d+)([hdwm])$/i);
  if (!m) return spec;
  const n = Number(m[1]);
  const ms = { h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3 }[m[2].toLowerCase()];
  return new Date(Date.now() - n * ms).toISOString();
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
         c.repo,
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
      `SELECT id, source, title, project, repo, updated_at, message_count
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
