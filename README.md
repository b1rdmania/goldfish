# goldfish 🐠

**The memory layer you can actually trust, built for people who run agents everywhere.**

A local-first context layer for your AI history. Ingest everything from Claude, ChatGPT and Claude Code into a single SQLite database on your machine, then expose it to any MCP-compatible agent — scoped per agent, secrets redacted at ingest. No cloud, no account, no telemetry, no Docker, no vector database. One process, one file. ([Website](https://b1rdmania.github.io/goldfish/))

Your best thinking is trapped in ephemeral chat windows across three apps, and every new session has a three-second memory. If you run agents on a Mac mini, in a terminal, in Cursor and on your phone, none of them share a brain — and the memory layers that exist either ship your history to a cloud or want you running Postgres and Qdrant to hold your own conversations. goldfish puts your whole history in one place your agents can read, on terms you control. The goldfish that never forgets.

## How it works

```
Claude export ───┐
ChatGPT export ──┤
Gemini Takeout ──┼─► SQLite + FTS5 (~/.goldfish/goldfish.db) ─► MCP server ─► any agent
Hermes export ───┤
Claude Code  ────┤   (sessions, live)
Codex CLI  ──────┤   (sessions)
Cursor  ─────────┘   (composer history)
```

## Quick start

Requires Node ≥ 22.16 (uses the built-in `node:sqlite` with FTS5 — no native dependencies; earlier 22.x builds ship `node:sqlite` without the FTS5 module).

```bash
npm install
npm link   # puts `goldfish` on your PATH

# Ingest (Claude: Settings → Privacy → Export data; ChatGPT: Settings → Data controls → Export;
# Gemini: Google Takeout → My Activity → Gemini Apps, activity records as JSON)
goldfish ingest claude ~/Downloads/claude-export/conversations.json
goldfish ingest chatgpt ~/Downloads/chatgpt-export/conversations.json
goldfish ingest gemini ~/Downloads/Takeout/My\ Activity/Gemini\ Apps/MyActivity.json
goldfish ingest hermes backup.jsonl    # from: hermes sessions export backup.jsonl
goldfish ingest claude-code            # reads ~/.claude/projects automatically
goldfish ingest codex                  # reads ~/.codex/sessions automatically
goldfish ingest cursor                 # reads Cursor's local composer history automatically
goldfish watch                         # ...or keep it live: re-ingests sessions as you work

goldfish stats
goldfish search "postgres index latency"
goldfish search "auth refactor" --repo myrepo   # conversations are linked to git repos
goldfish log                           # audit: what every agent searched and read
goldfish export --all --out ~/vault/ai-history  # markdown, Obsidian-friendly
```

Optional semantic search (the only network call in goldfish, localhost-only, opt-in):

```bash
ollama pull nomic-embed-text
goldfish embed                         # embeds your history locally
goldfish search "that time we argued about caching" --semantic
```

`--semantic` is hybrid: BM25 and cosine result lists fused with reciprocal rank fusion, so exact-vocabulary hits and meaning-only hits both surface.

Ingestion **redacts likely secrets by default** — API keys, tokens, private-key blocks, connection-string passwords — before anything is stored, and reports counts (never content). Disable with `--no-redact` if you genuinely want secrets searchable.

### Remember only what you choose

Serve-time scoping limits what an agent can *see*; ingest-time selection limits what goldfish *remembers at all*. Personal chats you never ingest can never leak, whatever happens downstream:

```bash
# Preview the selection first — nothing is stored on a dry run:
goldfish ingest claude export.json --exclude personal --exclude therapy --since 90d --dry-run

# Work conversations only:
goldfish ingest claude export.json --match enticeable --match goldfish
goldfish ingest claude-code --project myrepo

# Changed your mind? Evict (previews first; deletes only with --force):
goldfish rm --match "health" --force
goldfish rm --before 2025-06-01 --force
```

`--match`/`--exclude` are case-insensitive title substrings; `--project` bounds Claude Code sessions by path; `--since`/`--before` take `90d`-style durations or ISO dates. `rm` removes the conversation, its messages, search index entries and embeddings in one transaction.

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

### Scope what each agent can see

An unscoped goldfish server gives the agent your **entire** AI history. For any agent that touches untrusted content (browses the web, reads email), scope it down:

```bash
# Only Claude Code transcripts, only this repo, only the last 30 days:
claude mcp add goldfish -- node /path/to/goldfish/src/server.js --source claude-code --repo myrepo --since 30d

# Or via env vars (comma-separated):
GOLDFISH_SOURCES=claude-code GOLDFISH_REPOS=myrepo GOLDFISH_SINCE=30d node src/server.js
```

Sources match exactly; projects and repos match as path substrings; `--since` takes `30d`/`12h`-style durations or an ISO date. The scope is a hard ceiling — tool arguments can't widen it, and out-of-scope conversations read as not found. Run different agents against differently scoped servers from the same database.

Every MCP tool call is recorded in a local audit log — which client, which tool, what query, how many results, under what scope (never message content). `goldfish log` shows you exactly what your agents have been reading.

## Security

goldfish concentrates years of private thinking into one file and hands it to agents — read [SECURITY.md](SECURITY.md) before connecting it to anything. The short version: the database is plaintext (filesystem permissions are the barrier), secret redaction is on by default at ingest, and the main risk is prompt injection of a *connected agent* exfiltrating transcripts — which is why scoping exists. Only connect an unscoped goldfish to an agent you'd trust with everything you've ever typed into an AI.

## Design notes

- **Zero native dependencies.** Uses Node 22's built-in `node:sqlite` (flagged experimental upstream, stable in practice). `npm install` takes two seconds on any machine.
- **FTS5 first, embeddings opt-in.** Keyword search over your own conversations is shockingly good because you remember your own vocabulary, so BM25 is the default and needs nothing installed. Semantic search exists (`goldfish embed` + `--semantic`) but runs against your own local Ollama — the no-cloud promise holds either way.
- **Re-ingestion is idempotent.** Conversations upsert by source-native ID; re-running an ingest refreshes rather than duplicates.
- **Redaction happens at the storage choke point** (`replaceMessages` in `src/db.js`), not in the parsers — a new parser can't forget to redact. Patterns are high-confidence only (gitleaks-style); prose that merely *mentions* passwords is untouched.
- **Claude Code's on-disk format is undocumented** and may change between versions; the parser is defensive and skips anything it doesn't recognise.
- **Gemini's export is an activity log, not a transcript.** Takeout always includes your prompts; responses are embedded when Google includes them. There's no conversation ID, so sessions are reconstructed by time gap (30 min) — stated honestly rather than papered over.
- **The moat we're not building:** continuous sync from the web apps. Both vendors only offer manual exports, so re-export every few weeks. Claude Code ingestion is fully automatic.

## Contributing

PRs very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Wanted, roughly in order of impact:

1. **More parsers** — OpenClaw, Gemini CLI, Windsurf; each is one file in `src/ingest/` ([#3](https://github.com/b1rdmania/goldfish/issues/3))
2. **`goldfish context <topic>`** — synthesise a structured brief from matching transcripts via any local or API model ([#4](https://github.com/b1rdmania/goldfish/issues/4))
3. **Export watcher** — detect a fresh Claude/ChatGPT export zip in `~/Downloads` and offer to ingest it ([#5](https://github.com/b1rdmania/goldfish/issues/5))

Shipped from this list already: live Claude Code ingestion ([#1](https://github.com/b1rdmania/goldfish/issues/1) → `goldfish watch`), local embeddings ([#2](https://github.com/b1rdmania/goldfish/issues/2) → `goldfish embed`), Gemini/Codex/Cursor/Hermes parsers ([#3](https://github.com/b1rdmania/goldfish/issues/3)), hybrid ranking ([#7](https://github.com/b1rdmania/goldfish/issues/7)) and `goldfish redact` ([#8](https://github.com/b1rdmania/goldfish/issues/8)).

## License

MIT
