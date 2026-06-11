// Live Claude Code ingestion: watch ~/.claude/projects and re-ingest session
// files as they change. Sessions append while active, so events are debounced
// per file. Re-ingestion is idempotent, so a redundant trigger is harmless.
// Defensive throughout — the on-disk format is undocumented.

import { watch } from "node:fs";
import { join, dirname, basename } from "node:path";
import { ingestSessionFile, PROJECTS_DIR } from "./ingest/claude-code.js";

const DEBOUNCE_MS = 2000;

export function watchClaudeCode(db, projectsDir = PROJECTS_DIR, { onIngest = () => {} } = {}) {
  const timers = new Map();

  const watcher = watch(projectsDir, { recursive: true }, (_event, relPath) => {
    if (!relPath || !relPath.endsWith(".jsonl")) return;
    const filePath = join(projectsDir, relPath);
    clearTimeout(timers.get(filePath));
    timers.set(
      filePath,
      setTimeout(() => {
        timers.delete(filePath);
        try {
          const encodedProject = basename(dirname(filePath));
          const id = ingestSessionFile(db, filePath, encodedProject);
          if (id) onIngest(id);
        } catch {
          /* never let a malformed event kill the watcher */
        }
      }, DEBOUNCE_MS)
    );
  });

  return () => {
    watcher.close();
    for (const t of timers.values()) clearTimeout(t);
  };
}
