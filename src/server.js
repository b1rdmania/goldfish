#!/usr/bin/env node
// goldfish MCP server — exposes your local AI conversation history to any
// MCP-compatible client (Claude Code, Claude Desktop, OpenClaw, Codex, ...).
//
// Register with Claude Code:
//   claude mcp add goldfish -- node /path/to/goldfish/src/server.js
//
// Scoping (recommended — see SECURITY.md): limit what a connected agent can
// see with repeatable flags or env vars. Sources match exactly; projects
// match as path substrings.
//   node src/server.js --source claude-code --project myrepo
//   GOLDFISH_SOURCES=claude-code GOLDFISH_PROJECTS=myrepo node src/server.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.js";
import { searchTranscripts, readConversation, listRecent, stats } from "./search.js";

function flagValues(name) {
  const out = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) out.push(...argv[++i].split(","));
  }
  return out;
}

const scope = {
  sources: [...flagValues("--source"), ...(process.env.GOLDFISH_SOURCES?.split(",") ?? [])]
    .map((s) => s.trim()).filter(Boolean),
  projects: [...flagValues("--project"), ...(process.env.GOLDFISH_PROJECTS?.split(",") ?? [])]
    .map((s) => s.trim()).filter(Boolean),
};

const scopeNote = [
  scope.sources.length ? `sources: ${scope.sources.join(", ")}` : null,
  scope.projects.length ? `projects matching: ${scope.projects.join(", ")}` : null,
].filter(Boolean).join("; ");

// stderr is safe for MCP stdio servers (protocol runs on stdout). Scope only — never content.
console.error(`goldfish: scope ${scopeNote || "unrestricted (consider --source/--project, see SECURITY.md)"}`);

const db = openDb();

const server = new McpServer({ name: "goldfish", version: "0.2.0" });

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const scoped = (desc) => (scopeNote ? `${desc} (This server is scoped to ${scopeNote}.)` : desc);

server.tool(
  "search_transcripts",
  scoped("Full-text search across ingested AI conversations (Claude, ChatGPT, Claude Code). Returns matching snippets with conversation IDs."),
  {
    query: z.string().describe("Keywords to search for"),
    source: z.enum(["claude", "chatgpt", "claude-code"]).optional()
      .describe("Restrict to one source"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, source, limit }) =>
    text(searchTranscripts(db, query, { source: source ?? null, limit, scope }))
);

server.tool(
  "read_conversation",
  scoped("Read a full conversation transcript by its conversation_id (from search results)."),
  {
    conversation_id: z.string(),
    max_chars: z.number().int().min(1000).max(200_000).default(60_000),
  },
  async ({ conversation_id, max_chars }) => {
    const conv = readConversation(db, conversation_id, { maxChars: max_chars, scope });
    return conv ? text(conv) : text(`No conversation found with id ${conversation_id}`);
  }
);

server.tool(
  "list_recent_conversations",
  scoped("List the most recently updated conversations, optionally filtered by source."),
  {
    source: z.enum(["claude", "chatgpt", "claude-code"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ source, limit }) => text(listRecent(db, { source: source ?? null, limit, scope }))
);

server.tool(
  "transcript_stats",
  scoped("Counts of ingested conversations and messages per source."),
  {},
  async () => text(stats(db, { scope }))
);

const transport = new StdioServerTransport();
await server.connect(transport);
