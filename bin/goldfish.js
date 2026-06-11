#!/usr/bin/env node
// goldfish CLI
//   goldfish ingest claude <conversations.json>
//   goldfish ingest chatgpt <conversations.json>
//   goldfish ingest claude-code [projects-dir]
//   goldfish search "<query>" [--source claude|chatgpt|claude-code]
//   goldfish stats

import { openDb, DB_PATH } from "../src/db.js";
import { ingestClaudeExport } from "../src/ingest/claude.js";
import { ingestChatGPTExport } from "../src/ingest/chatgpt.js";
import { ingestClaudeCode } from "../src/ingest/claude-code.js";
import { searchTranscripts, stats } from "../src/search.js";

const [, , cmd, ...args] = process.argv;
const db = openDb();

function usage() {
  console.log(`goldfish — local context layer (db: ${DB_PATH})

  goldfish ingest claude <conversations.json>
  goldfish ingest chatgpt <conversations.json>
  goldfish ingest claude-code [projects-dir]
  goldfish search "<query>" [--source <source>]
  goldfish stats`);
  process.exit(1);
}

switch (cmd) {
  case "ingest": {
    const [kind, path] = args;
    let n;
    if (kind === "claude") n = ingestClaudeExport(db, path);
    else if (kind === "chatgpt") n = ingestChatGPTExport(db, path);
    else if (kind === "claude-code") n = ingestClaudeCode(db, ...(path ? [path] : []));
    else usage();
    console.log(`Ingested ${n} conversations from ${kind}.`);
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
