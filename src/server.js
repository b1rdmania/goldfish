#!/usr/bin/env node
// goldfish MCP server — exposes your local AI conversation history to any
// MCP-compatible client (Claude Code, Claude Desktop, OpenClaw, Codex, ...).
//
// Register with Claude Code:
//   claude mcp add goldfish -- node /path/to/goldfish/src/server.js
//
// Scoping (recommended — see SECURITY.md): limit what a connected agent can
// see. Sources match exactly; projects/repos match as substrings; --since
// takes "30d"/"12h"-style durations or an ISO date.
//   node src/server.js --source claude-code --repo goldfish --since 30d
//   GOLDFISH_SOURCES=claude-code GOLDFISH_SINCE=30d node src/server.js
//
// Every tool call is recorded in the access log (what was asked, how many
// results — never content). Inspect with `goldfish log`.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb, logAccess } from "./db.js";
import { searchTranscripts, readConversation, listRecent, stats, sinceToIso } from "./search.js";
import { semanticSearch, embeddingsAvailable } from "./embed.js";

function flagValues(name) {
  const out = [];
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) out.push(...argv[++i].split(","));
  }
  return out;
}

const list = (flag, env) =>
  [...flagValues(flag), ...(process.env[env]?.split(",") ?? [])]
    .map((s) => s.trim())
    .filter(Boolean);

const scope = {
  sources: list("--source", "GOLDFISH_SOURCES"),
  projects: list("--project", "GOLDFISH_PROJECTS"),
  repos: list("--repo", "GOLDFISH_REPOS"),
  since: sinceToIso(flagValues("--since")[0] ?? process.env.GOLDFISH_SINCE ?? null),
};

const scopeNote = [
  scope.sources.length ? `sources: ${scope.sources.join(", ")}` : null,
  scope.projects.length ? `projects matching: ${scope.projects.join(", ")}` : null,
  scope.repos.length ? `repos matching: ${scope.repos.join(", ")}` : null,
  scope.since ? `since: ${scope.since}` : null,
].filter(Boolean).join("; ");

// stderr is safe for MCP stdio servers (protocol runs on stdout). Scope only — never content.
console.error(`goldfish: scope ${scopeNote || "unrestricted (consider --source/--project/--repo/--since, see SECURITY.md)"}`);

const db = openDb();

const server = new McpServer({ name: "goldfish", version: "0.3.0" });

const clientName = () => {
  const c = server.server.getClientVersion?.();
  return c ? `${c.name}@${c.version}` : null;
};

const audit = (tool, args, resultCount) => {
  try {
    logAccess(db, { client: clientName(), tool, args, resultCount, scope: scopeNote || "unrestricted" });
  } catch {
    /* auditing must never break serving */
  }
};

const text = (obj) => ({
  content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const scoped = (desc) => (scopeNote ? `${desc} (This server is scoped to ${scopeNote}.)` : desc);

server.tool(
  "search_transcripts",
  scoped("Full-text search across ingested AI conversations (Claude, ChatGPT, Claude Code). Returns matching snippets with conversation IDs. Set semantic=true for meaning-based search (requires `goldfish embed` to have been run)."),
  {
    query: z.string().describe("Keywords to search for"),
    source: z.enum(["claude", "chatgpt", "claude-code"]).optional()
      .describe("Restrict to one source"),
    semantic: z.boolean().default(false)
      .describe("Rank by meaning (local embeddings) instead of keywords"),
    limit: z.number().int().min(1).max(50).default(20),
  },
  async ({ query, source, semantic, limit }) => {
    let rows;
    if (semantic) {
      if (!embeddingsAvailable(db)) {
        audit("search_transcripts", { query, source, semantic }, 0);
        return text("Semantic search is not set up: run `goldfish embed` (requires local Ollama) first, or retry with semantic=false.");
      }
      const sources = source
        ? (scope.sources.length ? scope.sources.filter((s) => s === source) : [source])
        : scope.sources;
      if (source && !sources.length) {
        // Requested source is outside this server's scope.
        rows = [];
      } else {
        try {
          rows = await semanticSearch(db, query, { limit, scope: { ...scope, sources } });
        } catch (e) {
          audit("search_transcripts", { query, source, semantic }, 0);
          return text(`Semantic search unavailable (${e.message}); retry with semantic=false.`);
        }
      }
    } else {
      rows = searchTranscripts(db, query, { source: source ?? null, limit, scope });
    }
    audit("search_transcripts", { query, source, semantic }, rows.length);
    return text(rows);
  }
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
    audit("read_conversation", { conversation_id, max_chars }, conv ? 1 : 0);
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
  async ({ source, limit }) => {
    const rows = listRecent(db, { source: source ?? null, limit, scope });
    audit("list_recent_conversations", { source, limit }, rows.length);
    return text(rows);
  }
);

server.tool(
  "transcript_stats",
  scoped("Counts of ingested conversations and messages per source."),
  {},
  async () => {
    const rows = stats(db, { scope });
    audit("transcript_stats", {}, rows.length);
    return text(rows);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
