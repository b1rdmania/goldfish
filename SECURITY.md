# Security & threat model

goldfish stores your **entire AI conversation history** in plaintext and hands it to any MCP-connected agent. Read this before connecting it to anything.

## What goldfish does and doesn't do

- **No network calls, ever, by default.** Ingestion, search, and the MCP server are all local. The MCP server speaks stdio only — there is no port to attack remotely.
- **No encryption at rest.** The database (`~/.goldfish/goldfish.db`) is a plain SQLite file. Filesystem permissions are the only barrier. Anything that can read your home directory can read your full history in one file.
- **Ingest-time selection.** `--match`/`--exclude`/`--project`/`--since` filters (with `--dry-run` preview) bound what enters the database at all, and `goldfish rm` evicts conversations — messages, search index and embeddings included — after the fact. The strongest privacy control is the data you never store.
- **Secret redaction at ingest, on by default.** High-confidence patterns (API keys, OAuth/CI tokens, private-key blocks, JWTs, connection-string passwords, quoted `api_key = "..."` assignments) are replaced with `[REDACTED:<kind>]` before storage. Counts are reported; matched content is never logged. This is regex-based and **not a guarantee** — oddly formatted or free-text secrets ("my password is the dog's name") pass through. Disable with `--no-redact` or `GOLDFISH_NO_REDACT=1`. Note: redaction applies at ingest, so data ingested with older versions (or with redaction off) stays as stored until re-ingested.
- **Per-agent scoping on the MCP server.** `--source` / `--project` / `--repo` / `--since` flags (or `GOLDFISH_SOURCES` / `GOLDFISH_PROJECTS` / `GOLDFISH_REPOS` / `GOLDFISH_SINCE`) hard-limit what a connected agent can see across all four tools. The scope is set by whoever launches the server; tool arguments cannot widen it, and out-of-scope conversations are indistinguishable from nonexistent ones. An unscoped server still grants everything — scoping is opt-in by design, but strongly recommended for any agent that touches untrusted content.
- **Access audit log.** Every MCP tool call is recorded locally: client name, tool, caller arguments (the query or conversation id — never message content), result count, and the serving scope. `goldfish log` shows what each connected agent searched and read. If you suspect an agent was injected, the log is your forensic record of what it touched.
- **Semantic search is opt-in and localhost-only.** `goldfish embed` talks to a local Ollama instance — the only network call in the codebase, never on by default, never off-machine.

## The main risk: prompt injection through a connected agent

An agent with goldfish connected has the classic lethal trifecta:

1. access to private data (`search_transcripts`, `read_conversation`),
2. exposure to untrusted content (web pages, emails, files it reads), and
3. usually some way to communicate outward.

A malicious document the agent processes can instruct it to search your transcripts and exfiltrate the results. goldfish cannot defend against this — it is a property of the agent, not the database.

**Rule of thumb: only connect an *unscoped* goldfish to an agent you would trust with everything you have ever typed into an AI.** For agents that browse the web or read inbound email, use `--source`/`--project` scoping to cap the blast radius — an injected agent can then exfiltrate at most the scoped slice.

Secondary version of the same problem: old transcripts can themselves contain adversarial text (things you pasted from the web long ago). Search results return it into a live agent's context, where embedded instructions get a second chance to run.

## Practical guidance

- Keep `~/.goldfish/` out of cloud-synced folders and check whether your backup tooling should include it.
- Never commit the database. The repo's `.gitignore` excludes `*.db` / `*.db-wal` / `*.db-shm`; keep it that way.
- Never paste transcript content (including titles or search snippets) into issues, PRs, or logs.
- If you ingest exports on a shared machine, set restrictive permissions: `chmod 700 ~/.goldfish`.

## Roadmap items that would harden this further

- Optional encryption at rest
- Re-redaction pass over an existing database (`goldfish redact`), for data ingested before redaction existed
- Broader secret patterns / entropy-based detection (currently high-confidence regex only)

Contributions toward these are welcome — see the issue tracker. Hard constraint for any contribution: **no feature may make a network call by default, and nothing may log message content** (see CONTRIBUTING.md).

## Reporting

Found a vulnerability? Open a GitHub issue describing the class of problem — but never include real transcript content in a report. If demonstrating an issue requires sensitive detail, say so in the issue and a private channel can be arranged.
