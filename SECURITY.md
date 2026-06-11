# Security & threat model

goldfish stores your **entire AI conversation history** in plaintext and hands it to any MCP-connected agent. Read this before connecting it to anything.

## What goldfish does and doesn't do

- **No network calls, ever, by default.** Ingestion, search, and the MCP server are all local. The MCP server speaks stdio only — there is no port to attack remotely.
- **No encryption at rest.** The database (`~/.goldfish/goldfish.db`) is a plain SQLite file. Filesystem permissions are the only barrier. Anything that can read your home directory can read your full history in one file.
- **No redaction.** Whatever you pasted into past conversations — API keys, credentials, contracts, personal material — is ingested verbatim and is keyword-searchable.
- **No scoping.** Every connected agent gets every transcript. There are no per-agent or per-source permissions.

## The main risk: prompt injection through a connected agent

An agent with goldfish connected has the classic lethal trifecta:

1. access to private data (`search_transcripts`, `read_conversation`),
2. exposure to untrusted content (web pages, emails, files it reads), and
3. usually some way to communicate outward.

A malicious document the agent processes can instruct it to search your transcripts and exfiltrate the results. goldfish cannot defend against this — it is a property of the agent, not the database.

**Rule of thumb: only connect goldfish to an agent you would trust with everything you have ever typed into an AI.** Be especially careful with agents that browse the web or read inbound email.

Secondary version of the same problem: old transcripts can themselves contain adversarial text (things you pasted from the web long ago). Search results return it into a live agent's context, where embedded instructions get a second chance to run.

## Practical guidance

- Keep `~/.goldfish/` out of cloud-synced folders and check whether your backup tooling should include it.
- Never commit the database. The repo's `.gitignore` excludes `*.db` / `*.db-wal` / `*.db-shm`; keep it that way.
- Never paste transcript content (including titles or search snippets) into issues, PRs, or logs.
- If you ingest exports on a shared machine, set restrictive permissions: `chmod 700 ~/.goldfish`.

## Roadmap items that would harden this

- Secret detection/redaction pass at ingest time
- Per-source or per-project scoping on the MCP tools
- Optional encryption at rest

Contributions toward these are welcome — see the issue tracker. Hard constraint for any contribution: **no feature may make a network call by default, and nothing may log message content** (see CONTRIBUTING.md).

## Reporting

Found a vulnerability? Open a GitHub issue describing the class of problem — but never include real transcript content in a report. If demonstrating an issue requires sensitive detail, say so in the issue and a private channel can be arranged.
