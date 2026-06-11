// Ingest Claude Code sessions.
// Sessions are stored as JSONL under ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// Each line is an event; we keep user and assistant message events.
// NOTE: this is an undocumented on-disk format and may change between Claude Code
// versions — parsing is defensive on purpose. See docs.claude.com for the product itself.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { upsertConversation, replaceMessages } from "../db.js";
import { repoForPath } from "../git.js";

export const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b?.type === "text" && typeof b.text === "string") return b.text;
        if (b?.type === "tool_use") return `[tool: ${b.name}]`;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseSessionFile(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const msgs = [];
  let firstTs = null;
  let lastTs = null;
  let cwd = null;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    // Events carry the session's working directory — the authoritative project
    // path (the encoded directory name loses dashes and spaces).
    cwd ??= typeof ev.cwd === "string" ? ev.cwd : null;
    if (ev.type !== "user" && ev.type !== "assistant") continue;
    const content = extractText(ev.message?.content);
    if (!content.trim().length) continue;
    if (ev.timestamp) {
      firstTs ??= ev.timestamp;
      lastTs = ev.timestamp;
    }
    msgs.push({ role: ev.type, content, created_at: ev.timestamp ?? null });
  }
  return { msgs, firstTs, lastTs, cwd };
}

// Ingest one session file. Used by the full scan and by `goldfish watch`.
// Returns the conversation id, or null if the file had no usable messages.
export function ingestSessionFile(db, filePath, encodedProject) {
  let msgs, firstTs, lastTs, cwd;
  try {
    ({ msgs, firstTs, lastTs, cwd } = parseSessionFile(filePath));
  } catch {
    return null; // file vanished or unreadable mid-write
  }
  if (!msgs.length) return null;
  // Prefer the cwd recorded in events; fall back to decoding the dir name.
  const project = cwd ?? encodedProject.replace(/^-/, "/").replace(/-/g, "/");
  const id = `claude-code:${basename(filePath, ".jsonl")}`;
  upsertConversation(db, {
    id,
    source: "claude-code",
    title: msgs[0].content.slice(0, 120),
    project,
    created_at: firstTs,
    updated_at: lastTs,
    message_count: msgs.length,
    raw_path: filePath,
    repo: repoForPath(project),
  });
  replaceMessages(db, id, msgs);
  return id;
}

export function ingestClaudeCode(db, projectsDir = PROJECTS_DIR) {
  let count = 0;
  let projects;
  try {
    projects = readdirSync(projectsDir);
  } catch {
    return 0; // no Claude Code on this machine
  }
  for (const proj of projects) {
    const projPath = join(projectsDir, proj);
    if (!statSync(projPath).isDirectory()) continue;
    for (const file of readdirSync(projPath)) {
      if (!file.endsWith(".jsonl")) continue;
      if (ingestSessionFile(db, join(projPath, file), proj)) count++;
    }
  }
  return count;
}
