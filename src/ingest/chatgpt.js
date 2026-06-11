// Ingest a ChatGPT data export.
// Export via Settings → Data controls → Export; the zip contains conversations.json.
// Format: array of { id/conversation_id, title, create_time, update_time,
//   mapping: { nodeId: { message, parent, children } }, current_node }
// The mapping is a tree (edits create branches); we walk back from current_node
// to recover the canonical thread.

import { readFileSync } from "node:fs";
import { upsertConversation, replaceMessages } from "../db.js";

function nodeText(message) {
  const parts = message?.content?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.filter((p) => typeof p === "string").join("\n");
}

function threadFromMapping(mapping, currentNode) {
  const out = [];
  let nodeId = currentNode;
  while (nodeId) {
    const node = mapping[nodeId];
    if (!node) break;
    const m = node.message;
    if (m && m.author?.role !== "system") {
      const content = nodeText(m);
      if (content.trim().length) {
        out.push({
          role: m.author.role === "user" ? "user" : m.author.role === "tool" ? "tool" : "assistant",
          content,
          created_at: m.create_time ? new Date(m.create_time * 1000).toISOString() : null,
        });
      }
    }
    nodeId = node.parent;
  }
  return out.reverse();
}

export function ingestChatGPTExport(db, filePath) {
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  let count = 0;
  for (const conv of data) {
    const msgs = threadFromMapping(conv.mapping || {}, conv.current_node);
    if (!msgs.length) continue;
    const id = `chatgpt:${conv.conversation_id || conv.id}`;
    upsertConversation(db, {
      id,
      source: "chatgpt",
      title: conv.title || "(untitled)",
      project: null,
      created_at: conv.create_time ? new Date(conv.create_time * 1000).toISOString() : null,
      updated_at: conv.update_time ? new Date(conv.update_time * 1000).toISOString() : null,
      message_count: msgs.length,
      raw_path: filePath,
    });
    replaceMessages(db, id, msgs);
    count++;
  }
  return count;
}
