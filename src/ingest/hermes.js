// Ingest a Nous Research Hermes Agent session export.
// Produce the file with: hermes sessions export backup.jsonl
// One JSON object per line: { session_id, title, when, source,
//   messages: [{ role, content, tool_calls?, tool_name? }, ...] }
// NOTE: defensive — field presence varies between Hermes versions.

import { readFileSync } from "node:fs";
import { upsertConversation, replaceMessages } from "../db.js";

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (typeof b === "string" ? b : typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

export function ingestHermesExport(db, filePath, { filter = () => true, dryRun = false, onKeep = () => {} } = {}) {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let count = 0;
  for (const line of lines) {
    let session;
    try {
      session = JSON.parse(line);
    } catch {
      continue;
    }
    const sessionId = session.session_id ?? session.id;
    if (!sessionId || !Array.isArray(session.messages)) continue;
    const msgs = session.messages
      .map((m) => ({
        role: m.role === "user" ? "user" : m.role === "tool" ? "tool" : "assistant",
        content: contentText(m.content),
        created_at: m.timestamp ?? m.created_at ?? null,
      }))
      .filter((m) => m.content.trim().length && m.role !== "tool");
    if (!msgs.length) continue;
    const meta = {
      title: session.title || msgs[0].content.slice(0, 120),
      project: null,
      updated_at: session.when ?? null,
    };
    if (!filter(meta)) continue;
    onKeep(meta);
    count++;
    if (dryRun) continue;
    const id = `hermes:${sessionId}`;
    upsertConversation(db, {
      id,
      source: "hermes",
      title: meta.title,
      project: null,
      created_at: session.when ?? null,
      updated_at: session.when ?? null,
      message_count: msgs.length,
      raw_path: filePath,
    });
    replaceMessages(db, id, msgs);
  }
  return count;
}
