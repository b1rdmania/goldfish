// Ingest OpenAI Codex CLI sessions.
// Sessions live at ~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl
// Each line is { timestamp, type, payload }:
//   - type "session_meta": payload.id (session uuid), payload.cwd, payload.timestamp
//   - type "response_item": payload.type "message" with payload.role
//     ("user" | "assistant" | "developer") and payload.content [{ type, text }]
// Other line types (reasoning, function_call, turn_context, ...) are skipped.
// NOTE: undocumented format, may change between Codex versions — defensive.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { upsertConversation, replaceMessages } from "../db.js";
import { repoForPath } from "../git.js";

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");

function* walkJsonl(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkJsonl(p);
    else if (e.endsWith(".jsonl")) yield p;
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (typeof b?.text === "string" ? b.text : ""))
    .filter(Boolean)
    .join("\n");
}

function parseRollout(filePath) {
  const lines = readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  let meta = null;
  const msgs = [];
  let lastTs = null;
  for (const line of lines) {
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "session_meta" && ev.payload) meta = ev.payload;
    if (ev.type !== "response_item" || ev.payload?.type !== "message") continue;
    const role = ev.payload.role;
    if (role !== "user" && role !== "assistant") continue; // skip developer/system
    const content = contentText(ev.payload.content);
    if (!content.trim().length) continue;
    if (ev.timestamp) lastTs = ev.timestamp;
    msgs.push({ role, content, created_at: ev.timestamp ?? null });
  }
  return { meta, msgs, lastTs };
}

export function ingestCodex(db, sessionsDir = SESSIONS_DIR, { filter = () => true, dryRun = false, onKeep = () => {} } = {}) {
  let count = 0;
  for (const fp of walkJsonl(sessionsDir)) {
    let parsed;
    try {
      parsed = parseRollout(fp);
    } catch {
      continue;
    }
    const { meta, msgs, lastTs } = parsed;
    if (!msgs.length) continue;
    const firstUser = msgs.find((m) => m.role === "user");
    const metaInfo = {
      title: (firstUser ?? msgs[0]).content.slice(0, 120),
      project: meta?.cwd ?? null,
      updated_at: lastTs ?? meta?.timestamp ?? null,
    };
    if (!filter(metaInfo)) continue;
    onKeep(metaInfo);
    count++;
    if (dryRun) continue;
    const id = `codex:${meta?.id ?? fp.split("rollout-").pop().replace(".jsonl", "")}`;
    upsertConversation(db, {
      id,
      source: "codex",
      title: metaInfo.title,
      project: metaInfo.project,
      created_at: meta?.timestamp ?? msgs[0].created_at,
      updated_at: metaInfo.updated_at,
      message_count: msgs.length,
      raw_path: fp,
      repo: repoForPath(metaInfo.project),
    });
    replaceMessages(db, id, msgs);
  }
  return count;
}
