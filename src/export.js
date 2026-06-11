// Markdown export — one file per conversation, Obsidian-friendly frontmatter.
// The database stays the engine; this is a window into it (and a way out:
// your history is never locked in goldfish either).

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function conversationToMarkdown(conv, msgs) {
  const fm = [
    "---",
    `id: ${conv.id}`,
    `source: ${conv.source}`,
    `title: ${JSON.stringify(conv.title ?? "(untitled)")}`,
    conv.project ? `project: ${JSON.stringify(conv.project)}` : null,
    conv.repo ? `repo: ${conv.repo}` : null,
    conv.created_at ? `created: ${conv.created_at}` : null,
    conv.updated_at ? `updated: ${conv.updated_at}` : null,
    `messages: ${conv.message_count}`,
    "---",
  ].filter(Boolean);
  const body = msgs.map((m) => `## ${m.role}\n\n${m.content}`);
  return [...fm, "", `# ${conv.title ?? "(untitled)"}`, "", ...body].join("\n") + "\n";
}

function slug(s) {
  return (s || "untitled")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function exportConversation(db, conversationId) {
  const conv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(conversationId);
  if (!conv) return null;
  const msgs = db
    .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY idx`)
    .all(conversationId);
  return conversationToMarkdown(conv, msgs);
}

export function exportAll(db, outDir) {
  mkdirSync(outDir, { recursive: true });
  const convs = db.prepare(`SELECT id, title, updated_at FROM conversations`).all();
  let n = 0;
  for (const c of convs) {
    const md = exportConversation(db, c.id);
    if (!md) continue;
    const date = (c.updated_at || "").slice(0, 10) || "undated";
    writeFileSync(join(outDir, `${date}-${slug(c.title)}-${slug(c.id)}.md`), md);
    n++;
  }
  return n;
}
