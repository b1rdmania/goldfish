#!/usr/bin/env node
// goldfish CLI
//   goldfish ingest claude <conversations.json> [--no-redact]
//   goldfish ingest chatgpt <conversations.json> [--no-redact]
//   goldfish ingest claude-code [projects-dir] [--no-redact]
//   goldfish watch [projects-dir]                    # live Claude Code ingestion
//   goldfish search "<query>" [--source <s>] [--repo <r>] [--semantic]
//   goldfish serve [--source <s>] [--project <p>] [--repo <r>] [--since 30d]
//   goldfish log [--limit N]                         # what agents searched & read
//   goldfish export <conversation_id>                # markdown to stdout
//   goldfish export --all --out <dir>                # one markdown file each
//   goldfish embed                                   # opt-in: local Ollama embeddings
//   goldfish stats

import { openDb, DB_PATH, readAccessLog, deleteConversations } from "../src/db.js";
import { ingestClaudeExport } from "../src/ingest/claude.js";
import { ingestChatGPTExport } from "../src/ingest/chatgpt.js";
import { ingestClaudeCode } from "../src/ingest/claude-code.js";
import { searchTranscripts, stats, sinceToIso } from "../src/search.js";
import { setRedaction, redactionTotals } from "../src/redact.js";
import { buildFilter } from "../src/select.js";

const [, , cmd, ...rawArgs] = process.argv;

const hasFlag = (name) => rawArgs.includes(name);
const flagValue = (name) => {
  const i = rawArgs.indexOf(name);
  return i >= 0 ? rawArgs[i + 1] : null;
};
const flagValuesAll = (name) =>
  rawArgs.flatMap((a, i) => (a === name && rawArgs[i + 1] ? [rawArgs[i + 1]] : []));
// Positional args = everything that isn't a flag or a flag's value.
const flagsWithValues = ["--source", "--repo", "--out", "--limit", "--match", "--exclude", "--project", "--since", "--before"];
const positional = rawArgs.filter((a, i) => {
  if (a.startsWith("--")) return false;
  const prev = rawArgs[i - 1];
  return !(prev && flagsWithValues.includes(prev));
});

if (hasFlag("--no-redact")) setRedaction(false);

function usage() {
  console.log(`goldfish — local context layer (db: ${DB_PATH})

  goldfish ingest <claude|chatgpt|claude-code> [path]
      [--match <title>] [--exclude <title>] [--project <p>] [--since 90d]
      [--dry-run] [--no-redact]                  # bound what goldfish remembers
  goldfish watch [projects-dir]                  # live Claude Code ingestion
  goldfish search "<query>" [--source <s>] [--repo <r>] [--semantic]
  goldfish serve [--source <s>] [--project <p>] [--repo <r>] [--since 30d]
  goldfish log [--limit N]                       # what agents searched & read
  goldfish rm <id> | --match <t> | --source <s> | --before <date> [--force]
  goldfish export <conversation_id> | --all --out <dir>
  goldfish embed                                 # opt-in: local Ollama embeddings
  goldfish stats

Ingestion redacts likely secrets by default — see SECURITY.md.`);
  process.exit(1);
}

if (cmd === "serve") {
  // server.js reads --source/--project/--repo/--since from process.argv itself.
  await import("../src/server.js");
} else {
  const db = openDb();

  switch (cmd) {
    case "ingest": {
      const [kind, path] = positional;
      const dryRun = hasFlag("--dry-run");
      const opts = {
        filter: buildFilter({
          since: sinceToIso(flagValue("--since")),
          match: flagValuesAll("--match"),
          exclude: flagValuesAll("--exclude"),
          project: flagValuesAll("--project"),
        }),
        dryRun,
        onKeep: dryRun
          ? (m) => console.log(`  would ingest: ${m.title}${m.project ? `  (${m.project})` : ""}`)
          : () => {},
      };
      let n;
      if (kind === "claude") n = ingestClaudeExport(db, path, opts);
      else if (kind === "chatgpt") n = ingestChatGPTExport(db, path, opts);
      else if (kind === "claude-code") n = ingestClaudeCode(db, path || undefined, opts);
      else usage();
      if (dryRun) {
        console.log(`Dry run: ${n} conversation(s) match — nothing stored.`);
        break;
      }
      console.log(`Ingested ${n} conversations from ${kind}.`);
      const totals = redactionTotals();
      const redacted = Object.values(totals).reduce((a, b) => a + b, 0);
      if (redacted) {
        const byKind = Object.entries(totals).map(([k, v]) => `${k}: ${v}`).join(", ");
        console.log(`Redacted ${redacted} likely secret(s) before storing (${byKind}).`);
      } else if (!hasFlag("--no-redact")) {
        console.log("No likely secrets detected.");
      }
      break;
    }
    case "watch": {
      const { watchClaudeCode } = await import("../src/watch.js");
      const dir = positional[0];
      const stop = watchClaudeCode(db, ...(dir ? [dir] : []), {
        onIngest: (id) => console.log(`${new Date().toISOString()} re-ingested ${id}`),
      });
      console.log(`Watching for Claude Code session changes (ctrl-c to stop)...`);
      process.on("SIGINT", () => {
        stop();
        process.exit(0);
      });
      break;
    }
    case "search": {
      const source = flagValue("--source");
      const repo = flagValue("--repo");
      const query = positional.join(" ");
      if (!query) usage();
      const scope = repo ? { repos: [repo] } : {};
      let rows;
      if (hasFlag("--semantic")) {
        const { semanticSearch, embeddingsAvailable } = await import("../src/embed.js");
        if (!embeddingsAvailable(db)) {
          console.error("No embeddings yet — run `goldfish embed` first (requires local Ollama).");
          process.exit(1);
        }
        rows = await semanticSearch(db, query, {
          limit: 15,
          scope: { ...scope, sources: source ? [source] : [] },
        });
        for (const r of rows) {
          console.log(`\n[${r.source}] ${r.title}  (${r.conversation_id})  ${r.score.toFixed(3)}`);
          console.log(`  ${r.snippet.replace(/\n/g, " ")}`);
        }
      } else {
        rows = searchTranscripts(db, query, { source, limit: 15, scope });
        for (const r of rows) {
          console.log(`\n[${r.source}] ${r.title}  (${r.conversation_id})${r.repo ? `  [${r.repo}]` : ""}`);
          console.log(`  ${r.snippet.replace(/\n/g, " ")}`);
        }
      }
      if (!rows.length) console.log("No matches.");
      break;
    }
    case "log": {
      const limit = Number(flagValue("--limit")) || 50;
      const rows = readAccessLog(db, { limit });
      if (!rows.length) {
        console.log("Access log is empty — no MCP tool calls recorded yet.");
        break;
      }
      for (const r of rows.reverse()) {
        const args = JSON.parse(r.args || "{}");
        const what = args.query ?? args.conversation_id ?? "";
        console.log(
          `${r.ts}  ${(r.client ?? "unknown-client").padEnd(24)} ${r.tool.padEnd(26)} ${String(what).slice(0, 60).padEnd(62)} → ${r.result_count} result(s)  [scope: ${r.scope}]`
        );
      }
      break;
    }
    case "export": {
      const { exportConversation, exportAll } = await import("../src/export.js");
      if (hasFlag("--all")) {
        const out = flagValue("--out") || "./goldfish-export";
        const n = exportAll(db, out);
        console.log(`Exported ${n} conversations to ${out}/`);
      } else {
        const id = positional[0];
        if (!id) usage();
        const md = exportConversation(db, id);
        if (!md) {
          console.error(`No conversation found with id ${id}`);
          process.exit(1);
        }
        process.stdout.write(md);
      }
      break;
    }
    case "embed": {
      const { embedAll } = await import("../src/embed.js");
      console.log("Embedding messages via local Ollama (opt-in; the only network call in goldfish, localhost-only)...");
      try {
        const n = await embedAll(db, {
          onProgress: (done, total) => {
            if (done % 320 === 0 || done === total) console.log(`  ${done}/${total}`);
          },
        });
        console.log(n ? `Embedded ${n} new message(s).` : "Already up to date.");
      } catch (e) {
        console.error(`Embedding failed: ${e.message}`);
        console.error("Is Ollama running? Try: ollama pull nomic-embed-text && ollama serve");
        process.exit(1);
      }
      break;
    }
    case "rm": {
      // Select by id(s), or by --source/--match/--project/--before/--since.
      // Lists matches; deletes only with --force.
      let rows;
      if (positional.length) {
        rows = positional
          .map((id) => db.prepare(`SELECT id, source, title FROM conversations WHERE id = ?`).get(id))
          .filter(Boolean);
      } else {
        const clauses = [];
        const params = [];
        const source = flagValue("--source");
        if (source) { clauses.push(`source = ?`); params.push(source); }
        for (const m of flagValuesAll("--match")) {
          clauses.push(`lower(title) LIKE '%' || lower(?) || '%'`);
          params.push(m);
        }
        for (const p of flagValuesAll("--project")) {
          clauses.push(`project LIKE '%' || ? || '%'`);
          params.push(p);
        }
        const before = sinceToIso(flagValue("--before"));
        if (before) { clauses.push(`updated_at < ?`); params.push(before); }
        const since = sinceToIso(flagValue("--since"));
        if (since) { clauses.push(`updated_at >= ?`); params.push(since); }
        if (!clauses.length) usage();
        rows = db
          .prepare(`SELECT id, source, title FROM conversations WHERE ${clauses.join(" AND ")}`)
          .all(...params);
      }
      if (!rows.length) {
        console.log("No matching conversations.");
        break;
      }
      for (const r of rows) console.log(`  [${r.source}] ${r.title}  (${r.id})`);
      if (hasFlag("--force")) {
        deleteConversations(db, rows.map((r) => r.id));
        console.log(`Deleted ${rows.length} conversation(s) and their messages, search index and embeddings.`);
      } else {
        console.log(`${rows.length} conversation(s) match. Re-run with --force to delete.`);
      }
      break;
    }
    case "stats": {
      console.table(stats(db));
      break;
    }
    default:
      usage();
  }
}
