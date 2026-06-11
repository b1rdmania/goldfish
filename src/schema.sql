-- goldfish: local context layer schema
-- One row per conversation, one row per message, FTS5 over message text.

CREATE TABLE IF NOT EXISTS conversations (
  id          TEXT PRIMARY KEY,          -- source-native id, prefixed (e.g. "claude:uuid")
  source      TEXT NOT NULL,             -- 'claude' | 'chatgpt' | 'claude-code' | 'custom'
  title       TEXT,
  project     TEXT,                      -- claude-code project dir, or null
  created_at  TEXT,                      -- ISO 8601
  updated_at  TEXT,
  message_count INTEGER DEFAULT 0,
  raw_path    TEXT,                      -- path to original export file, for provenance
  repo        TEXT                       -- normalised git remote (host/owner/repo), or null
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  idx             INTEGER NOT NULL,      -- position within conversation
  role            TEXT NOT NULL,         -- 'user' | 'assistant' | 'system' | 'tool'
  content         TEXT NOT NULL,
  created_at      TEXT,
  UNIQUE (conversation_id, idx)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);

-- Full-text search over message content, joined back via rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  content='messages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Keep FTS in sync.
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
END;

-- Audit trail: one row per MCP tool call. Records what was asked and how much
-- came back — never message content. Inspect with `goldfish log`.
CREATE TABLE IF NOT EXISTS access_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,             -- ISO 8601
  client       TEXT,                      -- MCP client name/version, if known
  tool         TEXT NOT NULL,
  args         TEXT,                      -- JSON of caller args (query, ids, filters)
  result_count INTEGER,
  scope        TEXT                       -- active scope of the serving process
);

-- Optional semantic search sidecar (populated by `goldfish embed`, opt-in).
CREATE TABLE IF NOT EXISTS embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  model      TEXT NOT NULL,
  vector     BLOB NOT NULL                -- little-endian float32 array
);
