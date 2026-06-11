# Contributing to goldfish

Thanks for helping the goldfish remember. The codebase is deliberately small (~600 lines, zero native deps) — please keep it that way.

## Getting set up

```bash
git clone https://github.com/b1rdmania/goldfish
cd goldfish
npm install        # Node >= 22.16 required (built-in node:sqlite with FTS5)
npm link
```

Point the database somewhere disposable while developing:

```bash
export GOLDFISH_DB=/tmp/goldfish-dev.db
```

There's no test framework yet (see issue list) — smoke-test by ingesting a small export and running `goldfish search`. The MCP server can be exercised with the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node src/server.js
```

## Layout

```
src/schema.sql        — tables + FTS5 + sync triggers
src/db.js             — open/upsert helpers (node:sqlite)
src/ingest/*.js       — one parser per source, each exports a single ingest function
src/search.js         — FTS query, transcript reader, stats
src/server.js         — MCP server (stdio)
bin/goldfish.js       — CLI
```

## Adding a new source parser

This is the most useful kind of PR. The contract is small:

1. Create `src/ingest/<source>.js` exporting `ingest<Source>(db, path)`.
2. Map the source's native format to `{ role, content, created_at }` messages.
3. Use a stable, source-prefixed conversation ID (e.g. `cursor:<uuid>`) so re-ingestion stays idempotent — call `upsertConversation` then `replaceMessages`.
4. Be defensive: skip anything malformed rather than throwing. People's exports are messy.
5. Wire it into `bin/goldfish.js` and add the source to the README and the `source` enums in `src/server.js`.
6. Don't worry about secret redaction — `replaceMessages` applies it to everything stored, so parsers can't bypass it (see `src/redact.js`).

## Ground rules

- **Local-first is the point.** No feature may require a network call by default. Anything that talks to an API (embeddings, synthesis) must be opt-in.
- **No native dependencies** without a very good reason — `npm install` should never need a compiler.
- **Privacy:** never log message content; transcripts are people's private thinking.
- Keep PRs focused; one parser or one feature per PR.

## Open work

The roadmap lives in the README's Contributing section and in GitHub Issues. Comment on an issue before starting anything big so we don't duplicate effort.
