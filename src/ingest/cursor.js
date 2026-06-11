// Ingest Cursor IDE chat (composer) history.
// Conversations live in Cursor's global SQLite store:
//   <UserDir>/globalStorage/state.vscdb, table cursorDiskKV,
//   keys "composerData:<composerId>" → JSON with name, createdAt (ms epoch),
//   lastUpdatedAt, conversation: [{ type: 1|2, text, ... }] (1 = user, 2 = assistant).
// Project attribution comes from workspaceStorage/<hash>/workspace.json plus
// each workspace's state.vscdb ItemTable key "composer.composerData"
// (allComposers → composerId list).
// NOTE: undocumented format that has already changed once (legacy aichat
// "tabs" → composer "bubbles") — parsing is defensive; unreadable or empty
// composers are skipped.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { upsertConversation, replaceMessages } from "../db.js";
import { repoForPath } from "../git.js";

export function defaultCursorUserDir() {
  const home = homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Cursor", "User");
  if (platform() === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "Cursor", "User");
  return join(home, ".config", "Cursor", "User");
}

// Map composerId → project folder path, best-effort.
function composerProjects(userDir) {
  const map = new Map();
  const wsRoot = join(userDir, "workspaceStorage");
  let hashes;
  try {
    hashes = readdirSync(wsRoot);
  } catch {
    return map;
  }
  for (const hash of hashes) {
    let folder = null;
    try {
      const ws = JSON.parse(readFileSync(join(wsRoot, hash, "workspace.json"), "utf8"));
      const uri = ws.folder ?? ws.workspace ?? "";
      if (typeof uri === "string" && uri.startsWith("file://")) {
        folder = decodeURIComponent(fileURLToPath(uri));
      }
    } catch {
      /* no workspace.json or unparseable */
    }
    if (!folder) continue;
    try {
      const db = new DatabaseSync(join(wsRoot, hash, "state.vscdb"), { readOnly: true });
      const row = db
        .prepare(`SELECT value FROM ItemTable WHERE key = 'composer.composerData'`)
        .get();
      db.close();
      if (!row) continue;
      const data = JSON.parse(row.value);
      for (const c of data.allComposers ?? []) {
        if (c?.composerId) map.set(c.composerId, folder);
      }
    } catch {
      /* locked or schema drift — skip this workspace */
    }
  }
  return map;
}

export function ingestCursor(db, userDir = defaultCursorUserDir(), { filter = () => true, dryRun = false, onKeep = () => {} } = {}) {
  const globalDb = join(userDir, "globalStorage", "state.vscdb");
  if (!existsSync(globalDb)) return 0;

  let cursorDb;
  try {
    cursorDb = new DatabaseSync(globalDb, { readOnly: true });
  } catch {
    return 0; // locked or unreadable
  }

  const projects = composerProjects(userDir);
  let rows;
  try {
    rows = cursorDb
      .prepare(`SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'`)
      .all();
  } catch {
    cursorDb.close();
    return 0;
  }
  cursorDb.close();

  let count = 0;
  for (const row of rows) {
    let composer;
    try {
      composer = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (!composer || typeof composer !== "object") continue; // stored null happens
    const conv = Array.isArray(composer.conversation) ? composer.conversation : [];
    const msgs = conv
      .filter((e) => (e?.type === 1 || e?.type === 2) && typeof e.text === "string" && e.text.trim().length)
      .map((e) => ({
        role: e.type === 1 ? "user" : "assistant",
        content: e.text,
        created_at: e.timingInfo?.clientStartTime
          ? new Date(e.timingInfo.clientStartTime).toISOString()
          : null,
      }));
    if (!msgs.length) continue;
    const composerId = composer.composerId ?? row.key.slice("composerData:".length);
    const project = projects.get(composerId) ?? null;
    const meta = {
      title: composer.name || msgs[0].content.slice(0, 120),
      project,
      updated_at: composer.lastUpdatedAt
        ? new Date(composer.lastUpdatedAt).toISOString()
        : composer.createdAt
          ? new Date(composer.createdAt).toISOString()
          : null,
    };
    if (!filter(meta)) continue;
    onKeep(meta);
    count++;
    if (dryRun) continue;
    const id = `cursor:${composerId}`;
    upsertConversation(db, {
      id,
      source: "cursor",
      title: meta.title,
      project,
      created_at: composer.createdAt ? new Date(composer.createdAt).toISOString() : null,
      updated_at: meta.updated_at,
      message_count: msgs.length,
      raw_path: globalDb,
      repo: repoForPath(project),
    });
    replaceMessages(db, id, msgs);
  }
  return count;
}
