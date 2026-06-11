#!/usr/bin/env node
// goldfish MCP server — exposes your local AI conversation history to any
// MCP-compatible client (Claude Code, Claude Desktop, OpenClaw, Codex, ...).
//
// Register with Claude Code:
//   claude mcp add goldfish -- node /path/to/goldfish/src/server.js

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.js";
import { searchTranscripts, readConversation, listRecent, stats } from "./search.js";

const db = openDb();

const server = new McpServer({ name: "goldfish", version: "0.1.0" });

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

server.tool(
  "search_transcripts",
  "Full-text search across all ingested AI conversations (Claude, ChatGPT, Claude Code). Returns matching snippets with conversation IDs.",
  {
    query: z.string().describe("Keywords to search for"),
    source: z.enum(["claude", "chatgpt", "claude-code"]).optional()
      .describe("Restrict to one source"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, source, limit }) =>
    text(searchTranscripts(db, query, { source: source ?? null, limit }))
);

server.tool(
  "read_conversation",
  "Read a full conversation transcript by its conversation_id (from search results).",
  {
    conversation_id: z.string(),
    max_chars: z.number().int().min(1000).max(200_000).default(60_000),
  },
  async ({ conversation_id, max_chars }) => {
    const conv = readConversation(db, conversation_id, { maxChars: max_chars });
    return conv ? text(conv) : text(`No conversation found with id ${conversation_id}`);
  }
);

server.tool(
  "list_recent_conversations",
  "List the most recently updated conversations, optionally filtered by source.",
  {
    source: z.enum(["claude", "chatgpt", "claude-code"]).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  },
  async ({ source, limit }) => text(listRecent(db, { source: source ?? null, limit }))
);

server.tool(
  "transcript_stats",
  "Counts of ingested conversations and messages per source.",
  {},
  async () => text(stats(db))
);

const transport = new StdioServerTransport();
await server.connect(transport);
