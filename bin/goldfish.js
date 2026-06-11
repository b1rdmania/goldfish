#!/usr/bin/env node
// goldfish CLI
//   goldfish ingest claude <conversations.json> [--no-redact]
//   goldfish ingest chatgpt <conversations.json> [--no-redact]
//   goldfish ingest claude-code [projects-dir] [--no-redact]
//   goldfish search "<query>" [--source claude|chatgpt|claude-code]
//   goldfish serve [--source <s>] [--project <p>]
//   goldfish stats

import { openDb, DB_PATH } from "../src/db.js";
import { ingestClaudeExport } from "../src/ingest/claude.js";
import { ingestChatGPTExport } from "../src/ingest/chatgpt.js";
import { ingestClaudeCode } from "../src/ingest/claude-code.js";
import { searchTranscripts, stats } from "../src/search.js";
import { setRedaction, redactionTotals } from "../src/redact.js";

const [, , cmd, ...rawArgs] = process.argv;

const noRedact = rawArgs.includes("--no-redact");
const args = rawArgs.filter((a) => a !== "--no-redact");
if (noRedact) setRedaction(false);

function usage() {
  console.log(`goldfish — local context layer (db: ${DB_PATH})

  goldfish ingest claude <conversations.json> [--no-redact]
  goldfish ingest chatgpt <conversations.json> [--no-redact]
  goldfish ingest claude-code [projects-dir] [--no-redact]
  goldfish search "<query>" [--source <source>]
  goldfish serve [--source <s>] [--project <p>]   # MCP server, scoped
  goldfish stats

Ingestion redacts likely secrets (API keys, tokens, private keys,
connection-string passwords) by default — see SECURITY.md.`);
  process.exit(1);
}

if (cmd === "serve") {
  // server.js reads --source/--project from process.argv itself.
  await import("../src/server.js");
} else {
  const db = openDb();

  switch (cmd) {
    case "ingest": {
      const [kind, path] = args;
      let n;
      if (kind === "claude") n = ingestClaudeExport(db, path);
      else if (kind === "chatgpt") n = ingestChatGPTExport(db, path);
      else if (kind === "claude-code") n = ingestClaudeCode(db, ...(path ? [path] : []));
      else usage();
      console.log(`Ingested ${n} conversations from ${kind}.`);
      const totals = redactionTotals();
      const redacted = Object.values(totals).reduce((a, b) => a + b, 0);
      if (redacted) {
        const byKind = Object.entries(totals)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        console.log(`Redacted ${redacted} likely secret(s) before storing (${byKind}).`);
      } else if (!noRedact) {
        console.log("No likely secrets detected.");
      }
      break;
    }
    case "search": {
      const sourceIdx = args.indexOf("--source");
      const source = sourceIdx >= 0 ? args[sourceIdx + 1] : null;
      const query = args
        .filter((a, i) => sourceIdx < 0 || (i !== sourceIdx && i !== sourceIdx + 1))
        .join(" ");
      if (!query) usage();
      const rows = searchTranscripts(db, query, { source, limit: 15 });
      for (const r of rows) {
        console.log(`\n[${r.source}] ${r.title}  (${r.conversation_id})`);
        console.log(`  ${r.snippet.replace(/\n/g, " ")}`);
      }
      if (!rows.length) console.log("No matches.");
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
