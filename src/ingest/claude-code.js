// Ingest Claude Code sessions.
// Sessions are stored as JSONL under ~/.claude/projects/<encoded-project-path>/<session-uuid>.jsonl
// Each line is an event; we keep user and assistant message events.
// NOTE: this is an undocumented on-disk format and may change between Claude Code
// versions — parsing is defensive on purpose. See docs.claude.com for the product itself.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { upsertConversation, replaceMessages } from "../db.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

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
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "user" && ev.type !== "assistant") continue;
    const content = extractText(ev.message?.content);
    if (!content.trim().length) continue;
    if (ev.timestamp) {
      firstTs ??= ev.timestamp;
      lastTs = ev.timestamp;
    }
    msgs.push({ role: ev.type, content, created_at: ev.timestamp ?? null });
  }
  return { msgs, firstTs, lastTs };
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
      const fp = join(projPath, file);
      const { msgs, firstTs, lastTs } = parseSessionFile(fp);
      if (!msgs.length) continue;
      const id = `claude-code:${basename(file, ".jsonl")}`;
      upsertConversation(db, {
        id,
        source: "claude-code",
        title: msgs[0].content.slice(0, 120),
        project: proj.replace(/^-/, "/").replace(/-/g, "/"), // best-effort decode
        created_at: firstTs,
        updated_at: lastTs,
        message_count: msgs.length,
        raw_path: fp,
      });
      replaceMessages(db, id, msgs);
      count++;
    }
  }
  return count;
}
