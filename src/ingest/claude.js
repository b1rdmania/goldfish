// Ingest a Claude.ai data export.
// Export via Settings → Privacy → Export data; the zip contains conversations.json.
// Format: array of { uuid, name, created_at, updated_at, chat_messages: [{ sender, text, content, created_at }] }

import { readFileSync } from "node:fs";
import { upsertConversation, replaceMessages } from "../db.js";

function messageText(m) {
  if (typeof m.text === "string" && m.text.length) return m.text;
  if (Array.isArray(m.content)) {
    return m.content
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function ingestClaudeExport(db, filePath) {
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  let count = 0;
  for (const conv of data) {
    const msgs = (conv.chat_messages || [])
      .map((m) => ({
        role: m.sender === "human" ? "user" : "assistant",
        content: messageText(m),
        created_at: m.created_at ?? null,
      }))
      .filter((m) => m.content.trim().length);
    if (!msgs.length) continue;
    const id = `claude:${conv.uuid}`;
    upsertConversation(db, {
      id,
      source: "claude",
      title: conv.name || "(untitled)",
      project: null,
      created_at: conv.created_at ?? null,
      updated_at: conv.updated_at ?? null,
      message_count: msgs.length,
      raw_path: filePath,
    });
    replaceMessages(db, id, msgs);
    count++;
  }
  return count;
}
