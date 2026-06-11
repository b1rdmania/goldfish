# goldfish 🐠

**The goldfish that never forgets.**

A local-first context layer for your AI history. Ingest everything from Claude, ChatGPT and Claude Code into a single SQLite database on your machine, then expose it to any MCP-compatible agent. No cloud, no account, no telemetry — one process, one file.

Your best thinking is trapped in ephemeral chat windows across three apps, and every new session has a three-second memory. goldfish puts your whole history in one place your agents can actually read.

## How it works

```
Claude export ─┐
ChatGPT export ─┼─► SQLite + FTS5 (~/.goldfish/goldfish.db) ─► MCP server ─► any agent
Claude Code  ──┘
```

## Quick start

Requires Node ≥ 22.5 (uses the built-in `node:sqlite` — no native dependencies).

```bash
npm install
npm link   # puts `goldfish` on your PATH

# Ingest (Claude: Settings → Privacy → Export data; ChatGPT: Settings → Data controls → Export)
goldfish ingest claude ~/Downloads/claude-export/conversations.json
goldfish ingest chatgpt ~/Downloads/chatgpt-export/conversations.json
goldfish ingest claude-code            # reads ~/.claude/projects automatically

goldfish stats
goldfish search "postgres index latency"
```

## Hook up your agents

Claude Code:

```bash
claude mcp add goldfish -- node /path/to/goldfish/src/server.js
```

Claude Desktop — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "goldfish": { "command": "node", "args": ["/path/to/goldfish/src/server.js"] }
  }
}
```

Tools exposed: `search_transcripts`, `read_conversation`, `list_recent_conversations`, `transcript_stats`.

Then just ask: *"search my transcripts for what we decided about the database schema, read the full conversation, and brief me."* The "generate context" step is the agent's job — retrieval is ours.

## Design notes

- **Zero native dependencies.** Uses Node 22's built-in `node:sqlite` (flagged experimental upstream, stable in practice). `npm install` takes two seconds on any machine.
- **FTS5 over embeddings, deliberately.** Keyword search over your own conversations is shockingly good because you remember your own vocabulary. Semantic search is a clean extension point (`src/search.js`) — a local embedding model keeps the no-cloud promise.
- **Re-ingestion is idempotent.** Conversations upsert by source-native ID; re-running an ingest refreshes rather than duplicates.
- **Claude Code's on-disk format is undocumented** and may change between versions; the parser is defensive and skips anything it doesn't recognise.
- **The moat we're not building:** continuous sync from the web apps. Both vendors only offer manual exports, so re-export every few weeks. Claude Code ingestion is fully automatic.

## Contributing

PRs very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Wanted, roughly in order of impact:

1. **Live Claude Code ingestion** — `fs.watch` on `~/.claude/projects`, debounced re-parse of changed sessions
2. **Local embeddings** — optional semantic search via Ollama (nomic-embed), stored in a sidecar table, hybrid-ranked with BM25
3. **More parsers** — Cursor, Codex, OpenClaw, Gemini exports (each is one file in `src/ingest/`)
4. **`goldfish context <topic>`** — synthesise a structured brief from matching transcripts via any local or API model
5. **Export watcher** — detect a fresh Claude/ChatGPT export zip in `~/Downloads` and offer to ingest it

## License

MIT
