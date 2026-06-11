// Ingest Gemini history from a Google Takeout "My Activity" export.
//
// Takeout path: My Activity → select only "Gemini Apps", set activity records
// to JSON → the archive contains MyActivity.json. (The separate "Gemini"
// product in Takeout exports Gem configurations, not conversations.)
//
// Honest limitations of the source data, reflected here:
// - It's an activity log, not a transcript. Each record is one prompt, with
//   the response sometimes embedded as HTML (safeHtmlItem) and sometimes
//   absent. We keep what's there.
// - There is no conversation ID. Records are grouped into sessions by time
//   gap (30 minutes); the session ID is derived from the first record's
//   timestamp, so re-ingestion of the same export stays idempotent.
// NOTE: this is an undocumented format and may change — parsing is defensive.

import { readFileSync } from "node:fs";
import { upsertConversation, replaceMessages } from "../db.js";

const SESSION_GAP_MS = 30 * 60 * 1000;

function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isGeminiRecord(r) {
  if (typeof r?.title !== "string") return false;
  const header = r.header ?? "";
  const products = Array.isArray(r.products) ? r.products.join(" ") : "";
  return /gemini|bard/i.test(`${header} ${products}`);
}

function recordToTurns(r) {
  const turns = [];
  const prompt = r.title.replace(/^Prompted\s+/i, "").trim();
  if (prompt) turns.push({ role: "user", content: prompt, created_at: r.time ?? null });
  // Responses, when present, arrive as HTML fragments.
  const htmlItems = Array.isArray(r.safeHtmlItem) ? r.safeHtmlItem : [];
  const response = htmlItems
    .map((h) => (typeof h === "string" ? stripHtml(h) : typeof h?.html === "string" ? stripHtml(h.html) : ""))
    .filter(Boolean)
    .join("\n\n");
  if (response) turns.push({ role: "assistant", content: response, created_at: r.time ?? null });
  return turns;
}

export function ingestGeminiTakeout(db, filePath, { filter = () => true, dryRun = false, onKeep = () => {} } = {}) {
  const data = JSON.parse(readFileSync(filePath, "utf8"));
  if (!Array.isArray(data)) return 0;

  const records = data
    .filter(isGeminiRecord)
    .filter((r) => r.time)
    .sort((a, b) => (a.time < b.time ? -1 : 1));

  // Group consecutive records into sessions by time gap.
  const sessions = [];
  for (const r of records) {
    const last = sessions[sessions.length - 1];
    const gap = last ? new Date(r.time) - new Date(last.records[last.records.length - 1].time) : Infinity;
    if (last && gap < SESSION_GAP_MS) last.records.push(r);
    else sessions.push({ records: [r] });
  }

  let count = 0;
  for (const s of sessions) {
    const msgs = s.records.flatMap(recordToTurns).filter((m) => m.content.length);
    if (!msgs.length) continue;
    const first = s.records[0];
    const lastRec = s.records[s.records.length - 1];
    const meta = {
      title: msgs[0].content.slice(0, 120),
      project: null,
      updated_at: lastRec.time ?? null,
    };
    if (!filter(meta)) continue;
    onKeep(meta);
    count++;
    if (dryRun) continue;
    const id = `gemini:${first.time}`;
    upsertConversation(db, {
      id,
      source: "gemini",
      title: meta.title,
      project: null,
      created_at: first.time ?? null,
      updated_at: lastRec.time ?? null,
      message_count: msgs.length,
      raw_path: filePath,
    });
    replaceMessages(db, id, msgs);
  }
  return count;
}
